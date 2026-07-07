// ファイル概要:
// このファイルは emf.ts（CloudWatch EMF 出力 helper）の unit test です（Issue #203）。
// opt-in ゲート（METRICS_NAMESPACE）と EMF JSON の構造を検証します。

import { emitMetric } from './emf';

describe('emitMetric', () => {
  // console.log を spy し、実際の stdout 出力は抑止します。
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.METRICS_NAMESPACE;
    delete process.env.METRICS_SERVICE;
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.METRICS_NAMESPACE;
    delete process.env.METRICS_SERVICE;
  });

  it('METRICS_NAMESPACE 未設定なら何も出力しない（ローカル PoC の既定）', () => {
    emitMetric('PurchaseConfirmed', 1, 'Count');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('METRICS_NAMESPACE 設定時は EMF 形式の JSON を 1 行出力する', () => {
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';
    process.env.METRICS_SERVICE = 'api';

    emitMetric('PurchaseConfirmed', 1, 'Count');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(record._aws.CloudWatchMetrics[0].Namespace).toBe('TicketC2C/test');
    expect(record._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: 'PurchaseConfirmed', Unit: 'Count' },
    ]);
    // 追加 dimension なしの場合、dimension set は Service のみです。
    expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Service']]);
    expect(record.Service).toBe('api');
    expect(record.PurchaseConfirmed).toBe(1);
  });

  it('追加 dimension は「Service のみ」と「Service+追加」の 2 つの dimension set になる', () => {
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';

    emitMetric('PurchaseRejected', 1, 'Count', { Reason: 'insufficient_inventory' });

    const record = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ['Service'],
      ['Service', 'Reason'],
    ]);
    expect(record.Reason).toBe('insufficient_inventory');
    // METRICS_SERVICE 未設定時の Service は既定値 app です。
    expect(record.Service).toBe('app');
  });

  it('Milliseconds 単位の値もそのまま記録される', () => {
    process.env.METRICS_NAMESPACE = 'TicketC2C/test';

    emitMetric('WorkerProcessingLagMs', 1234, 'Milliseconds');

    const record = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(record.WorkerProcessingLagMs).toBe(1234);
    expect(record._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });
});
