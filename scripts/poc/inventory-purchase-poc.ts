// ファイル概要:
// このファイルは在庫 PoC を外側から実行する検証ドライバーです。
// PostgreSQL に検証用 event / 在庫を作り、NestJS API に購入リクエストを投げ、
// 最後に DB の最終状態を読んで在庫超過が起きていないか判定します。

// dotenv/config は .env の DATABASE_URL や PoC 用環境変数を process.env に読み込みます。
import 'dotenv/config';
// randomUUID は event / buyer / runId / requestId に使う UUID を生成します。
import { randomUUID } from 'node:crypto';
// performance は HTTP リクエスト単位の latency を測るために使います。
import { performance } from 'node:perf_hooks';
// Pool は PoC script から PostgreSQL を直接読む・seed するための接続プールです。
import { Pool } from 'pg';

// この script は在庫 PoC の「購入リクエストを投げる側」です。
// 1. DB にイベントと在庫を seed します。
// 2. 実際の NestJS API へ HTTP で購入リクエストを同時に投げます。
// 3. 最後に PostgreSQL を直接読んで、在庫超過が起きていないか確認します。
// DATABASE_URL は PostgreSQL へ seed / 集計するための接続先です。
const databaseUrl = getRequiredDatabaseUrl();
// API_BASE_URL は購入リクエストの送信先 API です。未指定ならローカル API の 3000 番を見ます。
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
// totalQuantity は seed するイベントの初期在庫数です。
const totalQuantity = Number(process.env.POC_TOTAL_QUANTITY ?? 20);
// purchaseAttempts は PoC script が API に投げる購入リクエスト総数です。
const purchaseAttempts = Number(process.env.POC_PURCHASE_ATTEMPTS ?? 50);
// purchaseConcurrency は同時に投げる購入リクエスト数です。
const purchaseConcurrency = Number(process.env.POC_PURCHASE_CONCURRENCY ?? 9);
// purchaseQuantity は 1 リクエストあたりの購入枚数です。
const purchaseQuantity = Number(process.env.POC_PURCHASE_QUANTITY ?? 1);

// PurchaseApiResult は購入 API が正常応答したときの body です。
interface PurchaseApiResult {
  // purchaseId は purchases table に作られた購入履歴 row の ID です。
  purchaseId: string;
  // status は API が confirmed / rejected のどちらを返したかを表します。
  status: 'confirmed' | 'rejected';
  // quantity はそのリクエストで要求した購入枚数です。
  quantity: number;
  // rejectionReason は rejected の理由です。confirmed の場合は null です。
  rejectionReason: string | null;
}

// PurchaseAttemptResult は 1 回の HTTP 購入試行を script 側で集計するための形です。
interface PurchaseAttemptResult {
  // ok は HTTP status が 2xx だったかどうかを表します。
  ok: boolean;
  // httpStatus は実際に返った HTTP status code です。通信失敗時は 0 を入れます。
  httpStatus: number;
  // latencyMs は fetch 開始から response body parse 完了までの経過時間です。
  latencyMs: number;
  // body は API の購入結果、または失敗時の message を入れます。
  body: PurchaseApiResult | { message?: unknown };
}

// InventoryRow は PoC 終了後に ticket_inventory から読む在庫状態です。
interface InventoryRow {
  // total_quantity は seed した初期在庫数です。
  total_quantity: number;
  // remaining_quantity は購入リクエスト処理後に残った在庫数です。
  remaining_quantity: number;
  // version は confirmed による在庫更新成功回数を見るための値です。
  version: number;
}

// PurchaseSummaryRow は purchases table を status ごとに集計した SQL 結果の 1 row です。
interface PurchaseSummaryRow {
  // status は confirmed / rejected の集計単位です。
  status: 'confirmed' | 'rejected';
  // PostgreSQL の count(*) は pg では string として返るため、後で number に変換します。
  purchase_count: string;
  // sum(quantity) も numeric 系として string で返るため、後で number に変換します。
  total_quantity: string;
}

// main は PoC script 全体の流れを上から順に実行する関数です。
async function main() {
  // 環境変数で指定できる数値 knob を、DB を変更する前に検証します。
  // POC_PURCHASE_ATTEMPTS=abc のような typo があれば、seed 前に止まります。
  validatePositiveInteger('POC_TOTAL_QUANTITY', totalQuantity);
  // purchaseAttempts はリクエスト総数なので、正の整数だけを許可します。
  validatePositiveInteger('POC_PURCHASE_ATTEMPTS', purchaseAttempts);
  // purchaseConcurrency は同時実行数なので、正の整数だけを許可します。
  validatePositiveInteger('POC_PURCHASE_CONCURRENCY', purchaseConcurrency);
  // purchaseQuantity は 1 回の購入枚数なので、正の整数だけを許可します。
  validatePositiveInteger('POC_PURCHASE_QUANTITY', purchaseQuantity);

  // script から PostgreSQL へ seed / 集計するための接続プールを作ります。
  const pool = new Pool({
    // databaseUrl は .env の DATABASE_URL から取得した接続文字列です。
    connectionString: databaseUrl,
    // 接続確立が 5 秒を超えたら失敗させます。
    connectionTimeoutMillis: 5000,
    // 未使用接続は 30 秒で閉じ、ローカル実行の open handle を抑えます。
    idleTimeoutMillis: 30_000,
    // script 側も API 側と同じく最大 10 接続に抑えます。
    max: 10,
  });
  // node-postgres は idle connection の予期しないエラーを pool の error event として出します。
  // listener を置かないと、Node.js が unhandled EventEmitter error として扱う可能性があります。
  pool.on('error', (error) => {
    // PoC script では復旧より原因把握を優先して、想定外の pool error を標準エラーへ出します。
    console.error('Unexpected PoC pool error:', error);
  });

  // try/finally にすることで、途中で失敗しても pool.end() は必ず実行します。
  try {
    // API が起動しているかを先に確認し、起動忘れなら seed 前後の混乱を減らします。
    await assertApiIsReady();
    // 購入対象となる event と在庫 row を PostgreSQL に直接作ります。
    const eventId = await seedEvent(pool);
    // runId は今回の PoC 実行を識別する UUID です。
    // requestId に含めることで、同じ実行内の購入試行を追いやすくします。
    const runId = randomUUID();

    // 購入 API は認証必須になったため（ADR-0010、Issue #135）、PoC 用の購入者を
    // signup API 経由で 1 人作成し、その JWT を全購入リクエストで使います。
    // buyerId のクライアント申告は廃止されており、purchases.buyer_id はこのユーザーの
    // users.id（トークンの sub claim）になります。requestId は runId+index で一意なので、
    // 同一 buyer でも idempotency の検証条件は変わりません。
    const accessToken = await signupPocBuyer(runId);

    // runWithConcurrency は purchaseAttempts 件の購入処理を、purchaseConcurrency 件ずつ実行します。
    // API 側 pool を枯らすことではなく在庫正しさの検証が目的なので、同時数は制御します。
    const results = await runWithConcurrency(
      // 総リクエスト数を渡します。
      purchaseAttempts,
      // 1 batch あたりの同時実行数を渡します。
      purchaseConcurrency,
      // 各 index に対して、同じ eventId / runId / トークンで購入リクエストを送ります。
      (index) => sendPurchase(eventId, runId, index, accessToken),
    );

    // Promise.allSettled の結果を、集計しやすい PurchaseAttemptResult の配列へ正規化します。
    const settled = results.map((result): PurchaseAttemptResult => {
      // fulfilled は HTTP 応答を受け取れて sendPurchase が正常に返ったケースです。
      if (result.status === 'fulfilled') {
        // sendPurchase が作った結果をそのまま採用します。
        return result.value;
      }

      // rejected は fetch 自体の失敗など、HTTP 結果に到達できなかったケースです。
      return {
        // ok=false として API 成功集計から除外します。
        ok: false,
        // HTTP status がないため 0 を入れて通信失敗扱いにします。
        httpStatus: 0,
        // latency も測定不能なので 0 にします。
        latencyMs: 0,
        // reason を文字列化し、後からログで見られる形にします。
        body: { message: String(result.reason) },
      };
    });

    // API への全購入試行が終わったあと、DB の最終状態を読みます。
    const [inventory, purchaseSummary] = await Promise.all([
      // ticket_inventory から在庫の最終状態を取得します。
      loadInventory(pool, eventId),
      // purchases から confirmed / rejected の件数と枚数を集計します。
      loadPurchaseSummary(pool, eventId),
    ]);
    // latency は HTTP request 開始から response body parse 完了までで測っています。
    // failed fetch は latencyMs=0 として除外します。
    const latencySummary = summarizeLatency(
      // settled から正の latency だけを取り出し、p50/p95/p99 を計算します。
      settled.map((result) => result.latencyMs).filter((value) => value > 0),
    );

    // apiConfirmed は API response body の status が confirmed だった件数です。
    const apiConfirmed = settled.filter(
      // filter callback では ok=true かつ body に status があるものだけを見ます。
      (result) =>
        // HTTP 2xx で返ったものだけを成功応答として数えます。
        result.ok &&
        // 通信失敗 body には status がないため、in operator で型を絞ります。
        'status' in result.body &&
        // confirmed と明示された応答だけを数えます。
        result.body.status === 'confirmed',
    ).length;
    // apiRejected は API response body の status が rejected だった件数です。
    const apiRejected = settled.filter(
      // confirmed と同じ条件で、status だけ rejected を見ます。
      (result) =>
        // HTTP 2xx の rejected は業務上の正常な拒否として扱います。
        result.ok &&
        // body が購入結果の形かどうかを確認します。
        'status' in result.body &&
        // 在庫不足などで rejected と返った応答を数えます。
        result.body.status === 'rejected',
    ).length;
    // apiErrors は confirmed / rejected のどちらにも分類できなかった試行数です。
    const apiErrors = settled.length - apiConfirmed - apiRejected;

    // DB 上で confirmed になった購入枚数の合計です。
    const dbConfirmedQuantity = purchaseSummary.confirmed.quantity;
    // oversold はこの PoC の中心的な合否判定です。
    // 「DB 上の confirmed 枚数」「残在庫」「初期在庫」の整合性を複数方向から確認します。
    const oversold =
      // confirmed 合計が初期在庫を超えたら、明確に売り過ぎです。
      dbConfirmedQuantity > inventory.total_quantity ||
      // 残在庫がマイナスなら、在庫更新の防御が壊れています。
      inventory.remaining_quantity < 0 ||
      // 初期在庫 - 残在庫 が confirmed 合計と一致しない場合も、在庫履歴が壊れています。
      inventory.total_quantity - inventory.remaining_quantity !==
        dbConfirmedQuantity;

    // summary は PoC の検証結果を JSON として出すためのオブジェクトです。
    const summary = {
      // eventId は今回 seed した検証対象イベントです。
      eventId,
      // attempts は API に投げた購入リクエスト総数です。
      attempts: purchaseAttempts,
      // concurrency は同時に投げたリクエスト数です。
      concurrency: purchaseConcurrency,
      // purchaseQuantity は 1 リクエストあたりの購入枚数です。
      purchaseQuantity,
      // api は HTTP API が返した分類結果です。
      api: {
        // confirmed は API が confirmed と返した件数です。
        confirmed: apiConfirmed,
        // rejected は API が rejected と返した件数です。
        rejected: apiRejected,
        // errors は通信失敗や想定外応答など、正常分類できなかった件数です。
        errors: apiErrors,
      },
      // database は PostgreSQL を直接読んだ最終状態です。
      database: {
        // totalQuantity は seed した初期在庫数です。
        totalQuantity: inventory.total_quantity,
        // remainingQuantity は全購入試行後の残在庫です。
        remainingQuantity: inventory.remaining_quantity,
        // version は confirmed による在庫更新成功回数の目安です。
        version: inventory.version,
        // confirmedPurchases は purchases table 上の confirmed row 件数です。
        confirmedPurchases: purchaseSummary.confirmed.count,
        // confirmedQuantity は purchases table 上の confirmed 枚数合計です。
        confirmedQuantity: purchaseSummary.confirmed.quantity,
        // rejectedPurchases は purchases table 上の rejected row 件数です。
        rejectedPurchases: purchaseSummary.rejected.count,
      },
      // latencyMs は HTTP 購入リクエストの p50/p95/p99 latency です。
      latencyMs: latencySummary,
      // oversold は在庫超過が検出されたかどうかです。false が期待値です。
      oversold,
    };

    // 人間と CI の両方が読みやすいように、summary を整形済み JSON で出力します。
    console.log(JSON.stringify(summary, null, 2));

    // 在庫超過、または API error が 1 件でもあれば PoC 失敗として exit code を 1 にします。
    if (oversold || apiErrors > 0) {
      // process.exit() ではなく exitCode を設定し、finally の pool.end() を実行させます。
      process.exitCode = 1;
    }
  } finally {
    // 成功・失敗に関係なく PostgreSQL pool を閉じます。
    await pool.end();
  }
}

// assertApiIsReady は購入リクエスト送信前に API の /health を確認する helper です。
async function assertApiIsReady() {
  // この PoC は service を直接呼ばず、実際の HTTP API 経由で検証します。
  // そのため API プロセスが起動していない場合は早めに失敗させます。
  const response = await fetch(`${apiBaseUrl}/health`);
  // 2xx 以外なら、購入検証を始めても意味がないため error にします。
  if (!response.ok) {
    // status code を含めておくと、API 起動不備の原因を追いやすくなります。
    throw new Error(`API health check failed: ${response.status}`);
  }
}

// signupPocBuyer は PoC 用の購入者アカウントを認証 API 経由で作成し、JWT を返す helper です。
async function signupPocBuyer(runId: string): Promise<string> {
  // 実際のクライアントと同じ signup endpoint を通すことで、認証フロー込みの購入経路を検証します。
  const response = await fetch(`${apiBaseUrl}/auth/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // runId を含めることで、実行のたびに一意な PoC 用メールアドレスになります。
      email: `poc-${runId}@example.com`,
      // パスワードも実行ごとにランダムにし、検証用アカウントの使い回しを避けます。
      password: `poc-pass-${randomUUID()}`,
    }),
  });

  // signup が失敗すると購入検証を始められないため、ここで明示的に失敗させます。
  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(
      `PoC buyer signup failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  // response からアクセストークンを取り出し、購入リクエストの Bearer トークンに使います。
  const result = (await response.json()) as { accessToken?: string };
  if (!result.accessToken) {
    throw new Error('PoC buyer signup response did not contain accessToken');
  }

  return result.accessToken;
}

// seedEvent は検証用イベントと在庫 row を PostgreSQL に直接作る helper です。
async function seedEvent(pool: Pool): Promise<string> {
  // 売る側の event 作成 API はこの在庫 PoC の範囲外です。
  // そのため、検証に必要な event と ticket_inventory は script が DB に直接 seed します。
  const event = await pool.query<{ id: string }>(
    // INSERT 後に event id を使いたいので RETURNING id を指定します。
    `
      INSERT INTO events (
        title,
        event_type,
        starts_at,
        location_latitude,
        location_longitude
      )
      VALUES ($1, $2, now() + interval '30 days', $3, $4)
      RETURNING id
    `,
    [
      // title には実行時刻を含め、複数回実行した seed data を見分けやすくします。
      `Inventory PoC ${new Date().toISOString()}`,
      // event_type は後続の検索 PoC でも使える想定の分類値です。
      'music',
      // location_latitude は東京駅付近の緯度を seed 値として入れています。
      '35.681236',
      // location_longitude は東京駅付近の経度を seed 値として入れています。
      '139.767125',
    ],
  );

  // INSERT した event の UUID を ticket_inventory 作成と API request に使います。
  const eventId = event.rows[0].id;

  // ticket_inventory はこの PoC の在庫正本なので、event とセットで必ず作ります。
  await pool.query(
    // total_quantity と remaining_quantity を同じ値で初期化します。
    `
      INSERT INTO ticket_inventory (
        event_id,
        total_quantity,
        remaining_quantity
      )
      VALUES ($1, $2, $2)
    `,
    // $1 は eventId、$2 は初期在庫 totalQuantity です。
    [eventId, totalQuantity],
  );

  // API へ購入リクエストを送るために、作成した eventId を返します。
  return eventId;
}

// sendPurchase は 1 回分の購入 HTTP request を API に送る helper です。
async function sendPurchase(
  // eventId は購入対象イベントです。
  eventId: string,
  // runId は今回の PoC 実行全体を識別する UUID です。
  runId: string,
  // index は同じ run の中で何番目の request かを表します。
  index: number,
  // accessToken は signupPocBuyer が取得した購入者の JWT です。
  accessToken: string,
): Promise<PurchaseAttemptResult> {
  // latency 計測の開始時刻を記録します。
  const startedAt = performance.now();
  // 実際の buyer client が叩くのと同じ HTTP endpoint に POST します。
  // service を直接呼ばず HTTP を通すことで、guard / controller も含めた流れを検証できます。
  const response = await fetch(`${apiBaseUrl}/events/${eventId}/purchases`, {
    // 購入 endpoint は POST で呼び出します。
    method: 'POST',
    headers: {
      // NestJS/Fastify が body を JSON として parse できるよう指定します。
      'content-type': 'application/json',
      // 購入は認証必須（Issue #135）のため、Bearer トークンを付けます。
      authorization: `Bearer ${accessToken}`,
    },
    // body には枚数と idempotency key を入れます。
    // 購入者はトークンの sub claim から決まるため、buyerId は送りません。
    body: JSON.stringify({
      // quantity は環境変数で指定できる 1 request あたりの購入枚数です。
      quantity: purchaseQuantity,
      // requestId は runId + index で一意にし、同じ request の再送と区別できる形にします。
      requestId: `${runId}-${index}`,
    }),
  });
  // API response body を JSON として読みます。
  const body = (await response.json()) as PurchaseAttemptResult['body'];
  // fetch 開始から body parse 完了までを latency として計算します。
  const latencyMs = performance.now() - startedAt;

  // 集計しやすい形にして caller へ返します。
  return {
    // response.ok は HTTP status が 200-299 かどうかです。
    ok: response.ok,
    // httpStatus は想定外応答の確認に使います。
    httpStatus: response.status,
    // latencyMs は後で percentile 集計に使います。
    latencyMs,
    // body は confirmed/rejected の分類に使います。
    body,
  };
}

// loadInventory は購入試行後の在庫正本を ticket_inventory から読む helper です。
async function loadInventory(pool: Pool, eventId: string): Promise<InventoryRow> {
  // 全購入リクエストが終わった後の source-of-truth を DB から直接読みます。
  const result = await pool.query<InventoryRow>(
    // total / remaining / version の 3 つが PoC の在庫検証に必要な値です。
    `
      SELECT total_quantity, remaining_quantity, version
      FROM ticket_inventory
      WHERE event_id = $1
    `,
    // $1 は seed した eventId です。
    [eventId],
  );

  // seedEvent が成功していれば在庫 row は必ず 1 件あるはずです。
  if (result.rowCount !== 1) {
    // 0 件や複数件は PoC の前提崩れなので、明示的に error にします。
    throw new Error(`Inventory not found for event ${eventId}`);
  }

  // 検証に使う在庫 row を返します。
  return result.rows[0];
}

// loadPurchaseSummary は purchases table を status ごとに集計する helper です。
async function loadPurchaseSummary(pool: Pool, eventId: string) {
  // API response の集計と DB 実態を比較できるよう、DB 側の confirmed/rejected を集計します。
  const result = await pool.query<PurchaseSummaryRow>(
    // purchases を status ごとに group by し、件数と枚数合計を取得します。
    `
      SELECT
        status,
        count(*) AS purchase_count,
        coalesce(sum(quantity), 0) AS total_quantity
      FROM purchases
      WHERE event_id = $1
      GROUP BY status
    `,
    // $1 は seed した eventId です。
    [eventId],
  );

  // status が片方しか存在しない場合にも扱いやすいよう、両方 0 で初期化します。
  const summary = {
    // confirmed は初期値として件数 0、枚数 0 を持ちます。
    confirmed: { count: 0, quantity: 0 },
    // rejected も初期値として件数 0、枚数 0 を持ちます。
    rejected: { count: 0, quantity: 0 },
  };

  // SQL 結果に含まれる status ごとの row を number に変換して summary へ入れます。
  for (const row of result.rows) {
    // count(*) は string で返るため number に変換します。
    const count = parseFiniteNumber('purchase_count', row.purchase_count);
    // sum(quantity) も string で返るため number に変換します。
    const quantity = parseFiniteNumber('total_quantity', row.total_quantity);

    // row.status は confirmed または rejected なので、対応する summary を上書きします。
    summary[row.status] = {
      // count は購入履歴 row の件数です。
      count,
      // quantity は購入枚数の合計です。
      quantity,
    };
  }

  // confirmed / rejected の両方を必ず含む集計結果を返します。
  return summary;
}

// summarizeLatency は latency 配列から p50 / p95 / p99 を計算する helper です。
function summarizeLatency(values: number[]) {
  // latency が 1 件もない場合は percentile を計算できません。
  if (values.length === 0) {
    // null にしておくと、0ms と「計測なし」を区別できます。
    return { p50: null, p95: null, p99: null };
  }

  // percentile 計算は昇順 sort された配列を前提にします。
  const sorted = [...values].sort((left, right) => left - right);

  // p50 / p95 / p99 を JSON に入れやすい object として返します。
  return {
    // p50 は中央値として、典型的な latency を見るために使います。
    p50: percentile(sorted, 0.5),
    // p95 は遅い側 5% を除いた latency を見るために使います。
    p95: percentile(sorted, 0.95),
    // p99 はかなり遅い tail latency を見るために使います。
    p99: percentile(sorted, 0.99),
  };
}

// percentile は sort 済み配列から指定 percentile の値を取り出します。
function percentile(sortedValues: number[], percentileValue: number): number {
  // ceil(n * p) - 1 の nearest-rank 方式で index を計算します。
  const index = Math.min(
    // index が配列末尾を超えないよう上限を設定します。
    sortedValues.length - 1,
    // percentileValue は 0.5 / 0.95 / 0.99 のような 0-1 の値です。
    Math.ceil(sortedValues.length * percentileValue) - 1,
  );

  // 小数第 2 位までに丸め、JSON summary を読みやすくします。
  return Number(sortedValues[index].toFixed(2));
}

// validatePositiveInteger は PoC の数値環境変数が正の整数かを検証します。
function validatePositiveInteger(name: string, value: number) {
  // Number.isInteger で整数性を確認し、0 以下は拒否します。
  if (!Number.isInteger(value) || value <= 0) {
    // name を error message に含めることで、どの環境変数が悪いか分かるようにします。
    throw new Error(`${name} must be a positive integer`);
  }
}

// runWithConcurrency は itemCount 件の async task を concurrency 件ずつ実行する helper です。
async function runWithConcurrency<T>(
  // itemCount は実行したい task の総数です。
  itemCount: number,
  // concurrency は同時に走らせる task 数です。
  concurrency: number,
  // task は index を受け取り、1 件分の非同期処理を返す関数です。
  task: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  // results には fulfilled / rejected の両方を失わずに保存します。
  const results: PromiseSettledResult<T>[] = [];

  // 全件を一気に投げず、concurrency 件ずつ batch に分けて実行します。
  // API の DB pool 枯渇ではなく、在庫更新の正しさに検証対象を絞るためです。
  for (let start = 0; start < itemCount; start += concurrency) {
    // end は現在 batch の終端 index です。最後の batch だけ itemCount 未満になることがあります。
    const end = Math.min(itemCount, start + concurrency);
    // start から end-1 までの index を task に渡し、同時実行する Promise 配列を作ります。
    const batch = Array.from({ length: end - start }, (_, offset) =>
      // offset を start に足して、全体で一意な index にします。
      task(start + offset),
    );
    // Promise.allSettled により、1 件が失敗しても他の結果を捨てずに集計できます。
    results.push(...(await Promise.allSettled(batch)));
  }

  // 全 batch の settled result を caller に返します。
  return results;
}

// parseFiniteNumber は pg が string で返した集計値を number に変換します。
function parseFiniteNumber(name: string, value: string): number {
  // PostgreSQL の count/sum 結果は string なので Number() で変換します。
  const parsedValue = Number(value);

  // NaN や Infinity になった場合は、想定外の DB 結果として失敗させます。
  if (!Number.isFinite(parsedValue)) {
    // name と元値を含め、どの集計値がおかしかったか分かるようにします。
    throw new Error(`Unexpected non-numeric ${name}: ${value}`);
  }

  // 検証済みの number を返します。
  return parsedValue;
}

// getRequiredDatabaseUrl は DATABASE_URL が設定されているかを確認する helper です。
function getRequiredDatabaseUrl(): string {
  // DATABASE_URL がないと seed / 集計の DB 接続ができないため、script 起動時に止めます。
  if (!process.env.DATABASE_URL) {
    // .env.example をコピーして .env を作る、というローカル手順が分かる message にしています。
    throw new Error('DATABASE_URL is required. Copy .env.example to .env for local PoC runs.');
  }

  // ここまで来れば DATABASE_URL は string として利用できます。
  return process.env.DATABASE_URL;
}

// main を実行して PoC script を開始します。
void main();
