// ファイル概要:
// このファイルは購入 API に対するスパイク負荷試験の k6 シナリオです。
// ADR-0004（SQS FIFO 見送り）の「再検討のトリガー」を実測判定するために、
// 「人気イベント 1 つへの集中負荷（hot）」と「複数イベントへの分散負荷（background）」を
// 同時に流し、hot 負荷が background の購入レイテンシを悪化させるかを測定します。
//
// 実行モード（環境変数 MODE で切り替え）:
// - baseline: background のみ（分散負荷の基準値を測る）
// - spike:    background + hot（集中負荷の影響を測る）
// - warmup:   短時間の軽負荷（Aurora auto-pause の cold start を除くための準備運転）
//
// 使い方は同ディレクトリの README.md を参照してください。

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// ---------- 設定（すべて環境変数で上書き可能） ----------

// BASE_URL は対象 API のオリジンです（例: https://ticket-api-dev.ticket-c2c.click）。
const BASE_URL = __ENV.BASE_URL;
// HOT_EVENT_ID は集中負荷をかける人気イベントの UUID です（spike モードで必須）。
const HOT_EVENT_ID = __ENV.HOT_EVENT_ID || '';
// BG_EVENT_IDS は分散負荷をかけるイベント UUID のカンマ区切りリストです。
const BG_EVENT_IDS = (__ENV.BG_EVENT_IDS || '').split(',').filter(Boolean);
// MODE は baseline / spike / warmup のいずれかです。
const MODE = __ENV.MODE || 'spike';
// BG_RATE は background の合計リクエストレート（req/s）です。
const BG_RATE = Number(__ENV.BG_RATE || 20);
// HOT_RATE は hot イベントへの集中リクエストレート（req/s）です。
const HOT_RATE = Number(__ENV.HOT_RATE || 200);
// DURATION は各シナリオの継続時間です。
const DURATION = __ENV.DURATION || '60s';

if (!BASE_URL) {
  throw new Error('BASE_URL is required');
}
if (MODE !== 'warmup' && BG_EVENT_IDS.length === 0) {
  throw new Error('BG_EVENT_IDS is required (comma-separated UUIDs)');
}
if ((MODE === 'spike' || MODE === 'warmup') && !HOT_EVENT_ID) {
  throw new Error('HOT_EVENT_ID is required for spike / warmup mode');
}

// ---------- カスタムメトリクス ----------

// 購入 API の業務結果を traffic タグ（hot / background）付きで数えます。
// oversold 検証は「confirmed 件数 == 初期在庫 - 最終残在庫」を README の手順で突き合わせます。
const purchaseConfirmed = new Counter('purchase_confirmed');
const purchaseRejectedPrecheck = new Counter('purchase_rejected_precheck');
const purchaseRejectedDb = new Counter('purchase_rejected_db');
const purchaseHttpError = new Counter('purchase_http_error');

// ---------- シナリオ定義 ----------

const scenarios = {};

if (MODE === 'warmup') {
  // warmup は Aurora auto-pause 解除と ACU スケールアップのための準備運転です。
  scenarios.warmup = {
    executor: 'constant-arrival-rate',
    rate: 10,
    timeUnit: '1s',
    duration: __ENV.DURATION || '30s',
    preAllocatedVUs: 20,
    maxVUs: 50,
    exec: 'hotPurchase',
  };
} else {
  // background: 複数イベントへ分散する通常負荷（baseline / spike 共通）。
  scenarios.background = {
    executor: 'constant-arrival-rate',
    rate: BG_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 50,
    maxVUs: 200,
    exec: 'backgroundPurchase',
  };
  if (MODE === 'spike') {
    // hot: 人気イベント 1 つへの集中負荷（技術検証計画フェーズ 3 の「100 倍相当」）。
    scenarios.hot = {
      executor: 'constant-arrival-rate',
      rate: HOT_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 600,
      exec: 'hotPurchase',
    };
  }
}

export const options = {
  scenarios,
  // sub-metric（traffic タグ別）を summary に出すため、閾値を宣言します。
  // レイテンシ閾値は「dev 最小構成での傾向把握」用の緩い目安で、合否は ADR 側で判断します。
  thresholds: {
    'http_req_duration{traffic:background}': ['p(95)<3000'],
    'http_req_duration{traffic:hot}': ['p(95)<10000'],
    'http_req_failed{traffic:background}': ['rate<0.05'],
    'http_req_failed{traffic:hot}': ['rate<0.05'],
    'purchase_confirmed{traffic:background}': ['count>=0'],
    'purchase_confirmed{traffic:hot}': ['count>=0'],
    'purchase_rejected_precheck{traffic:hot}': ['count>=0'],
    'purchase_rejected_db{traffic:hot}': ['count>=0'],
    'purchase_http_error{traffic:background}': ['count>=0'],
    'purchase_http_error{traffic:hot}': ['count>=0'],
  },
};

// ---------- リクエスト実装 ----------

// uuid は buyerId 用の UUID v4 を生成します（外部 jslib に依存しないための簡易実装）。
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// purchase は POST /events/:eventId/purchases を 1 回呼び、業務結果を集計します。
// requestId は付けません（Valkey 前段フィルタを通る本番のホットパスを測るため）。
function purchase(eventId, traffic) {
  const res = http.post(
    `${BASE_URL}/events/${eventId}/purchases`,
    JSON.stringify({ buyerId: uuid(), quantity: 1 }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { traffic },
      timeout: '30s',
    },
  );

  check(res, { 'status is 200': (r) => r.status === 200 }, { traffic });

  if (res.status !== 200) {
    purchaseHttpError.add(1, { traffic });
    return;
  }

  let body;
  try {
    body = res.json();
  } catch (_) {
    purchaseHttpError.add(1, { traffic });
    return;
  }

  if (body.status === 'confirmed') {
    purchaseConfirmed.add(1, { traffic });
  } else if (body.rejectionReason === 'sold_out_precheck') {
    // Valkey 前段フィルタによる拒否（Aurora に到達していない）。
    purchaseRejectedPrecheck.add(1, { traffic });
  } else {
    // DB 判定まで到達した上での在庫不足拒否。
    purchaseRejectedDb.add(1, { traffic });
  }
}

// backgroundPurchase は分散負荷用で、毎回ランダムな background イベントを選びます。
export function backgroundPurchase() {
  const eventId = BG_EVENT_IDS[Math.floor(Math.random() * BG_EVENT_IDS.length)];
  purchase(eventId, 'background');
}

// hotPurchase は集中負荷用で、常に同一の人気イベントを対象にします。
export function hotPurchase() {
  purchase(HOT_EVENT_ID, 'hot');
}
