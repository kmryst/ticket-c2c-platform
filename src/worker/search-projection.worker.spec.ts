// ファイル概要:
// このファイルは検索プロジェクション Worker の単体テストです（production-readiness L-5 / Issue #200）。
// pollOnce の「1 件処理 → 直後にその 1 件だけ DeleteMessage」という逐次処理を仕様として固定します。
// production-readiness の旧記載（「バッチ内で 1 件でも例外を投げると同バッチ内の
// 正常メッセージの削除もスキップされる」）は初期実装（PR #22）から実装と乖離しており、
// 実際は「処理済みメッセージのみ削除・失敗以降は未削除（visibility timeout 後に再配信）」が
// 正しい挙動です。将来のリファクタリング（バッチ一括削除化など）でこの性質が壊れた場合に
// テストで検知できるようにします。
//
// OpenSearch / SQS へは接続しません（createOpenSearchClient を moduleモック、
// SQSClient.prototype.send を spy に差し替え）。

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
  },
  index: jest.fn(),
  update: jest.fn(),
};

jest.mock('../opensearch', () => ({
  createOpenSearchClient: jest.fn(() => opensearchMock),
}));

// EventBridge → SQS body の外形（EventListed）を作る helper。
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

describe('SearchProjectionWorker.pollOnce', () => {
  let sqsSend: jest.SpyInstance;
  let worker: SearchProjectionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    sqsSend = jest.spyOn(SQSClient.prototype, 'send');
    worker = new SearchProjectionWorker(
      'https://sqs.example/queue',
      'opensearch.example',
    );
  });

  afterEach(() => {
    sqsSend.mockRestore();
  });

  // pollOnce は private のためテストから直接呼ぶ。
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
            eventListedMessage('e1', 'rh1'),
            eventListedMessage('e2', 'rh2'),
            eventListedMessage('e3', 'rh3'),
          ],
        });
      }
      return Promise.resolve({});
    });
    opensearchMock.index.mockResolvedValue({});

    await pollOnce();

    expect(opensearchMock.index).toHaveBeenCalledTimes(3);
    expect(deletedReceiptHandles()).toEqual(['rh1', 'rh2', 'rh3']);
  });

  it('バッチ途中（2件目）の例外では、処理済みの1件目だけ削除され、2件目以降は削除されない', async () => {
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            eventListedMessage('e1', 'rh1'),
            eventListedMessage('e2', 'rh2'),
            eventListedMessage('e3', 'rh3'),
          ],
        });
      }
      return Promise.resolve({});
    });
    // 2 件目（e2）の OpenSearch 書き込みだけ失敗させる。
    opensearchMock.index.mockImplementation(({ id }: { id: string }) =>
      id === 'e2'
        ? Promise.reject(new Error('opensearch write failed'))
        : Promise.resolve({}),
    );

    await expect(pollOnce()).rejects.toThrow('opensearch write failed');

    // 1 件目は処理済み・削除済み（巻き戻らない）。
    // 2 件目（失敗）と 3 件目（未処理）は削除されず、visibility timeout 後に再配信される。
    expect(deletedReceiptHandles()).toEqual(['rh1']);
    // 3 件目の処理（OpenSearch 書き込み）にも到達していない。
    const indexedIds = opensearchMock.index.mock.calls.map(
      ([args]: [{ id: string }]) => args.id,
    );
    expect(indexedIds).toEqual(['e1', 'e2']);
  });

  it('処理失敗したメッセージの再配信は同一 doc ID への upsert のため冪等である', async () => {
    // 1 回目: e1 の書き込みが失敗して削除されない → 2 回目（再配信）: 成功して削除される。
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [eventListedMessage('e1', 'rh1-redelivered')],
        });
      }
      return Promise.resolve({});
    });
    opensearchMock.index
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValue({});

    await expect(pollOnce()).rejects.toThrow('transient failure');
    expect(deletedReceiptHandles()).toEqual([]);

    await pollOnce();

    // 同一 doc ID（eventId）への index（全体置換）のため、二重処理でも結果は収束する。
    expect(opensearchMock.index).toHaveBeenCalledTimes(2);
    expect(opensearchMock.index).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'e1' }),
    );
    expect(deletedReceiptHandles()).toEqual(['rh1-redelivered']);
  });
});

// 可観測性（ADR-0014 / Issue #203）の追加仕様:
// - ReceiveMessage は SentTimestamp を要求し、削除完了時に処理遅延を EMF で出す
// - detail._traceContext が同梱されていても（無くても）処理は変わらない
describe('SearchProjectionWorker observability (Issue #203)', () => {
  let sqsSend: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let worker: SearchProjectionWorker;

  beforeEach(() => {
    jest.clearAllMocks();
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
      ...eventListedMessage('e1', 'rh1'),
      Attributes: { SentTimestamp: String(Date.now() - 5000) },
    };
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({ Messages: [message] });
      }
      return Promise.resolve({});
    });
    opensearchMock.index.mockResolvedValue({});

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

  it('detail に _traceContext が同梱されていても通常どおり処理・削除される', async () => {
    const body = JSON.parse(eventListedMessage('e1', 'rh1').Body);
    body.detail._traceContext = {
      'x-amzn-trace-id':
        'Root=1-5f84c7a1-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1',
    };
    sqsSend.mockImplementation((command) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            {
              MessageId: 'mid-e1',
              ReceiptHandle: 'rh1',
              Body: JSON.stringify(body),
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    opensearchMock.index.mockResolvedValue({});

    await pollOnce();

    expect(opensearchMock.index).toHaveBeenCalledTimes(1);
    // _traceContext はプロジェクションのドキュメントへは書き込まれない。
    const indexedDoc = opensearchMock.index.mock.calls[0][0].body;
    expect(indexedDoc).not.toHaveProperty('_traceContext');
  });
});
