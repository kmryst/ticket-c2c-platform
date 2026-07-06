// ファイル概要:
// このファイルは「レート制限・監査に使うクライアント IP」を X-Forwarded-For から解決する helper です（ADR-0012、Issue #165）。
// X-Forwarded-For はクライアントが任意の値を先頭に足せるため、無条件には信用しません。
// 「インフラ（CloudFront → ALB）が末尾に追加する既知のプロキシ段数」を RATE_LIMIT_TRUSTED_PROXY_HOPS で
// 固定し、右から数えてその段数を飛ばした位置の値をクライアント IP とみなします。
//
// 例: viewer 1.2.3.4 → CloudFront（XFF に viewer を追記）→ ALB（XFF に CloudFront edge を追記）→ API
//     XFF = "1.2.3.4, 130.176.x.x" となるため、hops=1 で右から 1 つ飛ばした "1.2.3.4" を採用します。
// クライアントが偽装値を先頭に足しても、右からの解決では位置が変わらないため影響を受けません
// （CloudFront を経由せず ALB を直接叩く経路は除く。ADR-0012 のトレードオフに記載）。

// FastifyRequest そのものに依存させず、必要な形だけを構造的型で受けます（テスト容易性のため）。
export interface ClientIpSource {
  // headers は Fastify が parse した HTTP ヘッダの map です。
  headers: Record<string, string | string[] | undefined>;
  // ip は Fastify が返す TCP 接続元アドレス（ローカルでは実クライアント、AWS では ALB）です。
  ip?: string;
}

// resolveClientIp は trusted-hops 方式でクライアント IP を返します。
// XFF が無い・段数が足りない場合は TCP 接続元（request.ip）へフォールバックします。
export function resolveClientIp(request: ClientIpSource): string | undefined {
  const hops = parseTrustedProxyHops();
  const forwardedFor = normalizeHeader(request.headers['x-forwarded-for']);

  if (hops > 0 && forwardedFor) {
    // "a, b, c" を配列へ分解します。空要素（連続カンマ等）は捨てます。
    const entries = forwardedFor
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    // 右から hops 個は自インフラの追記なので飛ばし、その 1 つ左が実クライアントです。
    const index = entries.length - 1 - hops;
    if (index >= 0) {
      return entries[index];
    }
    // 段数が足りない（想定経路を通っていない）場合は TCP 接続元へフォールバックします。
  }

  // hops=0（ローカル PoC 既定）では XFF を一切信用せず、TCP 接続元をそのまま使います。
  return request.ip;
}

// parseTrustedProxyHops は RATE_LIMIT_TRUSTED_PROXY_HOPS を非負整数として読みます。
// 未設定・不正値は 0（XFF を信用しない）に倒します。安全側のデフォルトです。
function parseTrustedProxyHops(): number {
  const raw = process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;
  if (!raw) {
    return 0;
  }

  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    return 0;
  }

  return hops;
}

// normalizeHeader は string | string[] のヘッダ値を 1 本の文字列へ揃えます。
// 複数の X-Forwarded-For ヘッダは HTTP 的にカンマ結合と等価です。
function normalizeHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return value;
}
