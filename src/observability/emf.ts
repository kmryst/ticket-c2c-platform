// ファイル概要:
// このファイルは CloudWatch Embedded Metric Format（EMF）でビジネスメトリクスを出す helper です
// （ADR-0014 / Issue #203）。
// EMF 形式の構造化ログを stdout に 1 行出すだけで、awslogs ドライバ経由で CloudWatch Logs に届き、
// CloudWatch がログからメトリクスを自動抽出します。PutMetricData の API 呼び出しも
// 追加の IAM 権限も不要で、メトリクス送信の失敗がアプリの処理を巻き込むこともありません。
//
// METRICS_NAMESPACE 未設定（ローカル PoC 既定）では何も出しません（opt-in）。
// Terraform が dev / staging の ECS タスクへ METRICS_NAMESPACE / METRICS_SERVICE を設定します。

// traceLogFields はログ ↔ trace 相関のための trace id / span id です（Issue #255）。
import { traceLogFields } from './trace-context';

// MetricUnit は CloudWatch がサポートする単位のうち、このリポジトリで使うものだけを列挙します。
export type MetricUnit = 'Count' | 'Milliseconds';

// emitMetric はメトリクス 1 件を EMF 形式で stdout へ出力します。
// - name / value / unit がメトリクス本体です。
// - extraDimensions を渡すと、「Service のみ」と「Service + 追加 dimension」の 2 つの
//   dimension set で記録されます。追加 dimension で分解しても、Service 単位の合計が
//   別クエリなしで見えるようにするためです。
// - dimension は CloudWatch 上でメトリクスの系列数（課金対象）を増やすため、
//   値が有限集合になるもの（rejection reason など）だけを渡してください。
export function emitMetric(
  name: string,
  value: number,
  unit: MetricUnit,
  extraDimensions: Record<string, string> = {},
): void {
  // 名前空間が未設定なら EMF を出しません。ローカル PoC の stdout を汚さないための opt-in です。
  const namespace = process.env.METRICS_NAMESPACE;
  if (!namespace) {
    return;
  }

  // Service dimension は API / Worker のどちらが出したメトリクスかを区別します。
  const service = process.env.METRICS_SERVICE ?? 'app';

  // dimension set は「Service のみ」を基本とし、追加 dimension があれば分解用 set も足します。
  const extraKeys = Object.keys(extraDimensions);
  const dimensionSets: string[][] =
    extraKeys.length > 0 ? [['Service'], ['Service', ...extraKeys]] : [['Service']];

  // EMF の仕様に従い、_aws メタデータとメトリクス値・dimension 値を同じ JSON に入れます。
  // traceId / spanId はログ属性としてのみ含めます（Issue #255）。dimension set には
  // 絶対に加えません。trace id は高カーディナリティ値であり、dimension にすると
  // CloudWatch メトリクスの系列数（課金対象）が無際限に増えるためです。
  // EMF は _aws.CloudWatchMetrics.Dimensions に列挙されたキーだけを dimension として抽出し、
  // それ以外の top-level キーは CloudWatch Logs 上の検索可能なログ属性に留まります。
  const record: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: dimensionSets,
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    Service: service,
    ...extraDimensions,
    ...traceLogFields(),
    [name]: value,
  };

  // console.log は awslogs ドライバ経由で CloudWatch Logs に届きます。
  // JSON.stringify が失敗する値は渡していないため、ここでの例外は想定しません。
  console.log(JSON.stringify(record));
}
