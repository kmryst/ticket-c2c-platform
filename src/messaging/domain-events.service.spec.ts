// ファイル概要:
// このファイルは DomainEventsService の publish 失敗検出の単体テストです（Issue #377）。
// - EventBridge SDK throw
// - HTTP 成功でも FailedEntryCount > 0
// - entry-level error（ErrorCode / ErrorMessage）
// を検出し、metric を低カーディナリティ dimension で出すこと、secret / payload 全体を log に
// 出さないことを検証します。publish は throw しない（結果整合の projection）。

import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DomainEventsService } from './domain-events.service';

describe('DomainEventsService.publish 失敗検出', () => {
  let sendSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENT_BUS_NAME = 'test-bus';
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';
    sendSpy = jest.spyOn(EventBridgeClient.prototype, 'send');
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    sendSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.EVENT_BUS_NAME;
    delete process.env.METRICS_NAMESPACE;
  });

  function publishMetricRecords(): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map(([line]) => line)
      .filter(
        (line): line is string =>
          typeof line === 'string' && line.includes('DomainEventPublish'),
      )
      .map((line) => JSON.parse(line));
  }

  it('SDK throw を検出し sdk_error metric を出す（throw しない）', async () => {
    sendSpy.mockRejectedValue(new Error('network down'));
    const service = new DomainEventsService();

    await expect(
      service.publish('InventoryChanged', { eventId: 'e1' }),
    ).resolves.toBeUndefined();

    const records = publishMetricRecords();
    expect(records).toHaveLength(1);
    expect(records[0].Outcome).toBe('sdk_error');
    expect(records[0].DetailType).toBe('InventoryChanged');
  });

  it('FailedEntryCount > 0 を検出し partial_failure metric を出す', async () => {
    sendSpy.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'InternalException', ErrorMessage: 'boom' }],
    });
    const service = new DomainEventsService();

    await service.publish('InventoryChanged', { eventId: 'e1' });

    const records = publishMetricRecords();
    expect(records[0].Outcome).toBe('partial_failure');
  });

  it('entry-level error（FailedEntryCount 未設定でも ErrorCode あり）を検出する', async () => {
    sendSpy.mockResolvedValue({
      Entries: [{ ErrorCode: 'ThrottlingException' }],
    });
    const service = new DomainEventsService();

    await service.publish('InventoryChanged', { eventId: 'e1' });

    expect(publishMetricRecords()[0].Outcome).toBe('partial_failure');
  });

  it('成功時は success metric を出す', async () => {
    sendSpy.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'x' }] });
    const service = new DomainEventsService();

    await service.publish('InventoryChanged', { eventId: 'e1' });

    expect(publishMetricRecords()[0].Outcome).toBe('success');
  });

  it('publish metric dimension は DetailType / Outcome の有限集合だけ', async () => {
    sendSpy.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'x' }] });
    const service = new DomainEventsService();

    await service.publish('InventoryChanged', { eventId: 'secret-event' });

    const record = publishMetricRecords()[0];
    const dimensionSets = (
      record._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> }
    ).CloudWatchMetrics[0].Dimensions;
    const dims = new Set(dimensionSets.flat());
    expect(dims.has('DetailType')).toBe(true);
    expect(dims.has('Outcome')).toBe(true);
    expect(dims.has('eventId')).toBe(false);
  });

  it('entry error log に ErrorMessage / payload 全体を出さない', async () => {
    sendSpy.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'InternalException', ErrorMessage: 'sensitive detail' }],
    });
    const service = new DomainEventsService();

    await service.publish('InventoryChanged', { eventId: 'e1', secretField: 'x' });

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('InternalException');
    expect(logged).not.toContain('sensitive detail');
    expect(logged).not.toContain('secretField');
  });
});
