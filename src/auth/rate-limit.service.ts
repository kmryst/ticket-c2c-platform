// ファイル概要:
// このファイルは認証系エンドポイント（signup / login / refresh）と購入エンドポイント（purchase）の
// レート制限 service です（ADR-0012 / ADR-0015、Issue #167 / #205 / #204、production-readiness L-9）。
// Valkey 上の固定ウィンドウカウンタで「IP 単位」と「第 2 系統（メール / トークン / user_id）単位」の
// 2 系統を数え、どちらかが閾値を超えたら 429 を返します。
//
// 設計方針（ADR-0012）:
// - レート制限は「失効の正本」ではなく緩和策なので、Valkey 未設定・障害時は fail-open
//   （制限なしで続行）とします。M-1/M-2 の Valkey 前段フィルタと同じ責務分離です。
// - カウンタの INCR と EXPIRE 設定は Lua script で原子化します（M-2 で確立したパターン）。
//   素の INCR + EXPIRE を分けると、EXPIRE 前にプロセスが落ちた場合に TTL なしキーが残り、
//   永久にカウントされ続けるためです。
// - IP は client-ip.ts の trusted-hops 解決を通した値を受け取ります（偽装対策）。
// - 超過時は構造化ログ（`event: 'rate_limit_exceeded'`）と EMF メトリクス（`<Endpoint>RateLimited`）を
//   残します（Issue #204）。購入エンドポイントは特に PurchaseRateLimited という名前になります。

// HttpException は 429 Too Many Requests を返すために使います。
// Injectable は service を NestJS の DI 対象として登録する decorator です。
// OnModuleDestroy はアプリ終了時に Valkey 接続を閉じる lifecycle hook です。
import { HttpException, Injectable, OnModuleDestroy } from '@nestjs/common';
// Redis クライアント（ioredis）は Valkey と互換プロトコルで通信します。
import Redis from 'ioredis';
// getOptionalEnv は未設定・空文字を undefined に正規化して返す config helper です。
import { getOptionalEnv } from '../config';
// emitMetric はレート制限超過をビジネスメトリクス（EMF）として記録します（Issue #204、ADR-0014）。
import { emitMetric } from '../observability/emf';
// traceLogFields はセキュリティイベントログへ trace id / span id を付与します（Issue #255）。
import { traceLogFields } from '../observability/trace-context';

// RateLimitedEndpoint はレート制限の対象エンドポイント名です。カウンタのキー名にも使います。
export type RateLimitedEndpoint = 'signup' | 'login' | 'refresh' | 'purchase';

// RateLimitSubject は 1 リクエストの制限判定に使う主体情報です。
export interface RateLimitSubject {
  // ip は trusted-hops 解決後のクライアント IP です。undefined の場合 IP 系統は判定しません。
  ip?: string;
  // secondary は第 2 系統のキーです（signup / login はメールアドレス小文字、
  // refresh は提示トークンの識別値。メールは refresh リクエストに含まれないため）。
  secondary?: string;
}

// INCR_WITH_EXPIRE_SCRIPT は「カウンタ INCR + 初回のみ EXPIRE 設定 + 残 TTL 取得」を原子化した Lua script です。
// KEYS[1]=カウンタ、ARGV[1]=ウィンドウ秒。戻り値は {現在値, 残TTL秒} です。
const INCR_WITH_EXPIRE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

// DEFAULT_WINDOW_SECONDS は固定ウィンドウの幅（15 分）です。アクセストークン TTL と同じ粒度にします。
const DEFAULT_WINDOW_SECONDS = 15 * 60;

// DEFAULT_LIMITS はウィンドウあたりの既定の許容回数です。
// - signup: アカウント大量作成の抑止。正規ユーザーが 15 分に 10 回超 signup することはない。
// - login IP 20 / メール 10: credential stuffing（多メール×1IP）と総当たり（1メール集中）の両方を抑える。
// - refresh IP 60 / トークン 30: silent refresh は 15 分に 1 回程度なので、正規利用の 2 桁上を許容しつつ乱打を止める。
// - purchase（ADR-0015 / Issue #205）: dual-key 方式。secondary（user_id）10 がプライマリゲート
//   （正規ユーザーが 15 分に 10 回超の購入試行をすることはない。認証必須のためキーは常にある）。
//   IP 300 は緩いバックストップ（学校・オフィス NAT / 大手キャリアの相乗り正規ユーザーを
//   誤ブロックせず、単一 IP からのボット群れの物量だけを止める）。
// 環境変数（AUTH_RATE_LIMIT_<ENDPOINT>_<SCOPE>）で個別に上書きできます。
const DEFAULT_LIMITS: Record<RateLimitedEndpoint, { ip: number; secondary: number }> = {
  signup: { ip: 10, secondary: 10 },
  login: { ip: 20, secondary: 10 },
  refresh: { ip: 60, secondary: 30 },
  purchase: { ip: 300, secondary: 10 },
};

// AuthRateLimitService を NestJS の DI に登録します。
@Injectable()
// AuthRateLimitService は認証系レート制限の判定と 429 応答の組み立てを担当します。
export class AuthRateLimitService implements OnModuleDestroy {
  // client は VALKEY_URL が設定されている場合のみ作られます。null は無効化（fail-open）状態です。
  private readonly client: Redis | null;

  constructor() {
    const url = getOptionalEnv('VALKEY_URL');
    this.client = url
      ? new Redis(url, {
          // 障害時に認証 API 全体を巻き込まないよう、接続リトライは短く抑えます。
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
        })
      : null;

    if (this.client) {
      this.client.on('error', (error) => {
        // 接続断は fail-open で吸収するため、ここではログに残すだけにします。
        console.error('auth rate limit valkey error:', error);
      });
    }
  }

  // enforce は対象エンドポイントの IP 系統・第 2 系統のカウンタを進め、
  // どちらかが閾値を超えていたら 429 HttpException を投げます。
  // Valkey が使えない場合は何もしません（fail-open）。
  async enforce(
    endpoint: RateLimitedEndpoint,
    subject: RateLimitSubject,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    const windowSeconds = readPositiveIntEnv(
      'AUTH_RATE_LIMIT_WINDOW_SECONDS',
      DEFAULT_WINDOW_SECONDS,
    );

    // 判定対象のキーと閾値を組み立てます。値が無い系統（IP 不明など）は判定しません。
    const checks: Array<{ key: string; limit: number }> = [];
    if (subject.ip) {
      checks.push({
        key: `ratelimit:${endpoint}:ip:${subject.ip}`,
        limit: readPositiveIntEnv(
          `AUTH_RATE_LIMIT_${endpoint.toUpperCase()}_IP`,
          DEFAULT_LIMITS[endpoint].ip,
        ),
      });
    }
    if (subject.secondary) {
      checks.push({
        key: `ratelimit:${endpoint}:sub:${subject.secondary}`,
        limit: readPositiveIntEnv(
          `AUTH_RATE_LIMIT_${endpoint.toUpperCase()}_SECONDARY`,
          DEFAULT_LIMITS[endpoint].secondary,
        ),
      });
    }

    // retryAfter は超過した系統の残 TTL の最大値です（両系統超過時も 1 回の待機で回復できる値）。
    let retryAfterSeconds = 0;

    for (const check of checks) {
      try {
        // Lua script で INCR + 初回 EXPIRE + TTL 取得を原子的に行います。
        const result = (await this.client.eval(
          INCR_WITH_EXPIRE_SCRIPT,
          1,
          check.key,
          String(windowSeconds),
        )) as [number, number];

        const [count, ttl] = result;
        if (count > check.limit) {
          retryAfterSeconds = Math.max(retryAfterSeconds, ttl > 0 ? ttl : windowSeconds);
        }
      } catch (error) {
        // Valkey 障害はレート制限なしで続行します（fail-open。ADR-0012）。
        console.error('auth rate limit check failed (fail-open):', error);
        return;
      }
    }

    if (retryAfterSeconds > 0) {
      // セキュリティイベントとして構造化ログに残します（Issue #204）。
      // ip / secondary は監査時の追跡に必要なため、そのまま出します
      // （既に他のログ・レート制限キー自体にも同じ値が現れており、追加の漏洩経路ではありません）。
      console.warn(
        JSON.stringify({
          event: 'rate_limit_exceeded',
          endpoint,
          ip: subject.ip ?? null,
          secondary: subject.secondary ?? null,
          retryAfterSeconds,
          // trace id / span id で該当リクエストの X-Ray trace へ辿れるようにします（Issue #255）。
          // トレーシング無効時（ローカル PoC）は undefined のスプレッドとなり、フィールドは追加されません。
          ...traceLogFields(),
        }),
      );
      // 超過をビジネスメトリクスとしても記録します（Issue #204）。エンドポイント別に
      // 系列を分け、購入エンドポイントは特に PurchaseRateLimited という名前になります。
      emitMetric(`${capitalize(endpoint)}RateLimited`, 1, 'Count');

      // 429 応答。Retry-After 相当の値は body に含め、header は controller が設定します。
      throw new HttpException(
        {
          statusCode: 429,
          message: 'too many requests',
          retryAfterSeconds,
        },
        429,
      );
    }
  }

  // onModuleDestroy はアプリ終了時に Valkey 接続を閉じます。
  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      // quit はサーバへ切断を伝えます。失敗しても終了処理は止めません。
      await this.client.quit().catch(() => undefined);
    }
  }
}

// extractRetryAfterSeconds は enforce が投げた 429 例外から待機秒数を取り出します。
// controller 側で標準の Retry-After header を設定するために使います（auth / purchases 共用）。
export function extractRetryAfterSeconds(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'getResponse' in error &&
    typeof (error as { getResponse: unknown }).getResponse === 'function'
  ) {
    const response = (error as { getResponse: () => unknown }).getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'retryAfterSeconds' in response &&
      typeof (response as { retryAfterSeconds: unknown }).retryAfterSeconds ===
        'number'
    ) {
      return (response as { retryAfterSeconds: number }).retryAfterSeconds;
    }
  }
  return undefined;
}

// capitalize はメトリクス名（`${Endpoint}RateLimited`）を組み立てるための先頭大文字化です。
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// readPositiveIntEnv は環境変数を正の整数として読み、不正・未設定なら fallback を返します。
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = getOptionalEnv(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}
