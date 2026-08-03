// ファイル概要:
// このファイルは検索プロジェクション Worker の単体テストです
// （production-readiness L-5 / Issue #200、versioned 対応 Issue #377）。
// pollOnce の「1 件処理 → 直後にその 1 件だけ DeleteMessage」という逐次処理を仕様として固定し、
// versioned / legacy InventoryChanged と EventListed / EventUpdated の分岐、malformed payload を
// ack しないこと、mapping 適用失敗で poll を開始しないことを検証します。
//
// OpenSearch へは接続しません（createOpenSearchClient を module モック、
// SQSClient.prototype.send を spy に差し替え）。実 mapping / Painless script の挙動は
// events-projection.store.integration.spec.ts（実 OpenSearch）で検証します。

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SearchProjectionWorker } from './search-projection.worker';

// OpenSearch クライアントはネットワークを持たない fake に差し替える。
const opensearchMock = {
  indices: {
    exists: jest.fn(),
    create: jest.fn(),
    putMapping: jest.fn(),
  },
  index: jest.fn(),
  update: jest.fn(),
};

jest.mock('../opensearch', () => ({
  createOpenSearchClient: jest.fn(() => opensearchMock),
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const TYPE_UUID = '22222222-2222-2222-2222-222222222222';

function eventListedMessage(eventId: string, receiptHandle: string) {
  return {
    MessageId: `mid-${eventId}`,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify({
      'detail-type': 'EventListed',
      detail: {
        eventId,
        title: `event ${eventId}`,
        eventType: 'live',
        startsAt: '2026-08-01T10:00:00Z',
        totalQuantity: 100,
        remainingQuantity: 100,
      },
    }),
  };
}

function versionedInventoryMessage(
  eventId: string,
  receiptHandle: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    MessageId: `mid-${eventId}`,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify({
      'detail-type': 'InventoryChanged',
      detail: {
        eventId,
        remainingQuantity: 40,
        inventoryEventVersion: 1,
        ticketTypeId: TYPE_UUID,
        ticketTypeName: 'GA',
        ticketTypeTotalQuantity: 50,
        ticketTypeRemainingQuantity: 40,
        inventoryVersion: 3,
        eventTotalQuantity: 50,
        eventRemainingQuantity: 40,
        eventInventoryVersion: 3,
        ...overrides,
      },
    }),
  };
}

function legacyInventoryMessage(eventId: string, receiptHandle: string) {
  return {
    MessageId: `mid-${eventId}`,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify({
      'detail-type': 'InventoryChanged',
      detail: { eventId, remainingQuantity: 7 },
    }),
  };
}

describe('SearchProjectionWorker.pollOnce', () => {
  let sqsSend: jest.SpyInstance;
  let worker: SearchProjectionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    opensearchMock.update.mockResolvedValue({});
    sqsSend = jest.spyOn(SQSClient.prototype, 'send');
    worker = new SearchProjectionWorker(
      'https://sqs.example/queue',
      'opensearch.example',
    );
  });

  afterEach(() => {
    sqsSend.mockRestore();
  });

  function pollOnce(): Promise<void> {
    return (worker as unknown as { pollOnce(): Promise<void> }).pollOnce();
  }

  function deletedReceiptHandles(): string[] {
    return sqsSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteMessageCommand)
      .map((command) => (command as DeleteMessageCommand).input.ReceiptHandle!);
  }

  it('全件成功時は 1 件処理するごとにそのメッセージだけ削除する', async () => {
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            eventListedMessage(VALID_UUID, 'rh1'),
            versionedInventoryMessage(VALID_UUID, 'rh2'),
            legacyInventoryMessage(VALID_UUID, 'rh3'),
          ],
        });
      }
      return Promise.resolve({});
    });

    await pollOnce();

    expect(opensearchMock.update).toHaveBeenCalledTimes(3);
    expect(deletedReceiptHandles()).toEqual(['rh1', 'rh2', 'rh3']);
  });

  it('バッチ途中の例外では、処理済みの1件目だけ削除され、2件目以降は削除されない', async () => {
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            eventListedMessage(VALID_UUID, 'rh1'),
            versionedInventoryMessage(VALID_UUID, 'rh2'),
            legacyInventoryMessage(VALID_UUID, 'rh3'),
          ],
        });
      }
      return Promise.resolve({});
    });
    // 2 件目（versioned inventory）の OpenSearch 書き込みだけ失敗させる。
    opensearchMock.update.mockImplementation((args: { body?: unknown }) => {
      const body = args.body as { script?: unknown };
      return body?.script &&
        JSON.stringify(body).includes('inventory_version') &&
        JSON.stringify(body).includes(TYPE_UUID)
        ? Promise.reject(new Error('opensearch write failed'))
        : Promise.resolve({});
    });

    await expect(pollOnce()).rejects.toThrow('opensearch write failed');

    // 1 件目は処理済み・削除済み（巻き戻らない）。2 件目（失敗）以降は未削除。
    expect(deletedReceiptHandles()).toEqual(['rh1']);
  });

  it('OpenSearch エラー時はメッセージを削除しない（visibility timeout 後に再配信）', async () => {
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [versionedInventoryMessage(VALID_UUID, 'rh1')],
        });
      }
      return Promise.resolve({});
    });
    opensearchMock.update.mockRejectedValueOnce(new Error('transient failure'));

    await expect(pollOnce()).rejects.toThrow('transient failure');
    expect(deletedReceiptHandles()).toEqual([]);

    // 再配信（成功）で削除される（冪等な scripted update）。
    await pollOnce();
    expect(deletedReceiptHandles()).toEqual(['rh1']);
  });

  it('malformed な versioned payload は throw し、message を削除しない', async () => {
    // ticketTypeId が UUID でない部分 versioned payload。legacy へフォールバックさせない。
    const broken = {
      MessageId: 'mid-broken',
      ReceiptHandle: 'rh-broken',
      Body: JSON.stringify({
        'detail-type': 'InventoryChanged',
        detail: {
          eventId: VALID_UUID,
          remainingQuantity: 5,
          inventoryEventVersion: 1,
          ticketTypeId: 'not-a-uuid',
        },
      }),
    };
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({ Messages: [broken] });
      }
      return Promise.resolve({});
    });

    await expect(pollOnce()).rejects.toThrow();
    // OpenSearch へは書かず、message も削除しない。
    expect(opensearchMock.update).not.toHaveBeenCalled();
    expect(deletedReceiptHandles()).toEqual([]);
  });
});

describe('SearchProjectionWorker.start (ensureIndex)', () => {
  let worker: SearchProjectionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SearchProjectionWorker(
      'https://sqs.example/queue',
      'opensearch.example',
    );
  });

  function ensureIndex(): Promise<void> {
    return (worker as unknown as { ensureIndex(): Promise<void> }).ensureIndex();
  }

  it('既存 index でも putMapping で additive に mapping を適用する', async () => {
    opensearchMock.indices.exists.mockResolvedValue({ body: true });
    opensearchMock.indices.putMapping.mockResolvedValue({});

    await ensureIndex();

    expect(opensearchMock.indices.create).not.toHaveBeenCalled();
    expect(opensearchMock.indices.putMapping).toHaveBeenCalledTimes(1);
    const props = opensearchMock.indices.putMapping.mock.calls[0][0].body
      .properties as Record<string, unknown>;
    expect(props).toHaveProperty('ticket_types');
    expect(props).toHaveProperty('event_inventory_version');
  });

  it('未存在 index は完全 mapping で作成する', async () => {
    opensearchMock.indices.exists.mockResolvedValue({ body: false });
    opensearchMock.indices.create.mockResolvedValue({});

    await ensureIndex();

    expect(opensearchMock.indices.create).toHaveBeenCalledTimes(1);
    expect(opensearchMock.indices.putMapping).not.toHaveBeenCalled();
  });

  it('mapping 適用失敗時は throw し、message consumption を開始しない', async () => {
    opensearchMock.indices.exists.mockResolvedValue({ body: true });
    opensearchMock.indices.putMapping.mockRejectedValue(
      new Error('mapping failed'),
    );

    await expect(ensureIndex()).rejects.toThrow('mapping failed');
  });
});

// 可観測性（ADR-0014 / Issue #203）の追加仕様。
describe('SearchProjectionWorker observability (Issue #203)', () => {
  let sqsSend: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let worker: SearchProjectionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    opensearchMock.update.mockResolvedValue({});
    sqsSend = jest.spyOn(SQSClient.prototype, 'send');
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    worker = new SearchProjectionWorker(
      'https://sqs.example/queue',
      'opensearch.example',
    );
  });

  afterEach(() => {
    sqsSend.mockRestore();
    logSpy.mockRestore();
    delete process.env.METRICS_NAMESPACE;
  });

  function pollOnce(): Promise<void> {
    return (worker as unknown as { pollOnce(): Promise<void> }).pollOnce();
  }

  it('ReceiveMessage で SentTimestamp 属性を要求する', async () => {
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({ Messages: [] });
      }
      return Promise.resolve({});
    });

    await pollOnce();

    const receive = sqsSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof ReceiveMessageCommand) as
      | ReceiveMessageCommand
      | undefined;
    expect(receive?.input.MessageSystemAttributeNames).toEqual([
      'SentTimestamp',
    ]);
  });

  it('削除完了後に WorkerProcessingLagMs を EMF で出力する', async () => {
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';
    const message = {
      ...eventListedMessage(VALID_UUID, 'rh1'),
      Attributes: { SentTimestamp: String(Date.now() - 5000) },
    };
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({ Messages: [message] });
      }
      return Promise.resolve({});
    });

    await pollOnce();

    const emfLines = logSpy.mock.calls
      .map(([line]) => line)
      .filter(
        (line): line is string =>
          typeof line === 'string' && line.includes('WorkerProcessingLagMs'),
      );
    expect(emfLines).toHaveLength(1);
    const record = JSON.parse(emfLines[0]);
    expect(record.WorkerProcessingLagMs).toBeGreaterThanOrEqual(5000);
    expect(record._aws.CloudWatchMetrics[0].Namespace).toBe('TicketC2C/test');
  });

  it('ProjectionOutcome metric は有限 dimension（Operation / Outcome）だけを使う', async () => {
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [versionedInventoryMessage(VALID_UUID, 'rh1')],
        });
      }
      return Promise.resolve({});
    });

    await pollOnce();

    const outcomeLine = logSpy.mock.calls
      .map(([line]) => line)
      .find(
        (line): line is string =>
          typeof line === 'string' && line.includes('ProjectionOutcome'),
      );
    expect(outcomeLine).toBeDefined();
    const record = JSON.parse(outcomeLine as string);
    const dimensionSets = record._aws.CloudWatchMetrics[0].Dimensions as string[][];
    const dims = new Set(dimensionSets.flat());
    // 高カーディナリティ値は dimension に含めない。
    expect(dims.has('Operation')).toBe(true);
    expect(dims.has('Outcome')).toBe(true);
    expect(dims.has('eventId')).toBe(false);
    expect(dims.has('ticketTypeId')).toBe(false);
  });

  it('detail に _traceContext が同梱されていても通常どおり処理・削除される', async () => {
    const body = JSON.parse(versionedInventoryMessage(VALID_UUID, 'rh1').Body);
    body.detail._traceContext = {
      'x-amzn-trace-id':
        'Root=1-5f84c7a1-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1',
    };
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            { MessageId: 'mid', ReceiptHandle: 'rh1', Body: JSON.stringify(body) },
          ],
        });
      }
      return Promise.resolve({});
    });

    await pollOnce();

    expect(opensearchMock.update).toHaveBeenCalledTimes(1);
    // _traceContext は script params へ渡さない（業務 contract と分離）。
    const params = opensearchMock.update.mock.calls[0][0].body.script.params;
    expect(params).not.toHaveProperty('_traceContext');
  });
});
