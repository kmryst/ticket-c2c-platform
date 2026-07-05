// ファイル概要:
// このファイルは CloudFront 統合オリジンのパスルーティング（ADR-0011 決定 2）で
// `/api/*` として届いたリクエストを、既存の API ルート（プレフィックスなし）へ写像する
// URL 書き換え関数です。ALB にはパス書き換え機能がないため、アプリ側で吸収します。
// src/main.ts の FastifyAdapter（rewriteUrl オプション）から、ルーティング前に呼ばれます。

// stripApiPrefix は URL 先頭の /api プレフィックスを取り除きます。
// プレフィックスがない既存パス（/auth/login 等）はそのまま返すため、
// 既存クライアント（smoke test / k6）の経路には影響しません。
export function stripApiPrefix(url: string): string {
  // /api/auth/login → /auth/login（query string は slice でそのまま保たれます）
  if (url.startsWith('/api/')) {
    return url.slice(4);
  }

  // /api 単独はルートへ写像します。
  if (url === '/api') {
    return '/';
  }

  // /api?x=1 のような path なし + query の形はルート + query へ写像します。
  if (url.startsWith('/api?')) {
    return `/${url.slice(4)}`;
  }

  // /api で始まらない URL（既存経路）と、/apixxx のような別パスは書き換えません。
  return url;
}
