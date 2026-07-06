// ファイル概要:
// このファイルはブラウザから API を呼ぶための共通 fetch ヘルパーです（ADR-0011、ADR-0012）。
// ブラウザは常に同一オリジンの /api/* を叩き、AWS では CloudFront が ALB（API）へ、
// ローカル・E2E では next.config.ts の rewrite がバックエンドへ転送します。
// 認証は httpOnly Cookie（access_token / refresh_token）で行うため、トークンを JS で扱いません。
//
// silent refresh（ADR-0012、Issue #169）:
// アクセストークンは 15 分で失効するため、401 を受けたら POST /api/auth/refresh を
// 1 回だけ実行し、成功したら元のリクエストを 1 回リトライします。
// refresh は single-flight（同時 401 でも実行は 1 回、他はその Promise を待つ）にします。
// rotate-on-use のリフレッシュトークンを並行 refresh で二重消費すると、
// サーバ側の reuse detection がファミリー失効（強制ログアウト）と誤検知するためです。

// ApiError は API のエラー応答（NestJS の { statusCode, message } 形式）を画面へ伝える例外です。
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// AUTH_ENDPOINTS は 401 でも silent refresh を試みないパスです。
// - login / signup の 401 は「資格情報不一致」であり refresh しても解決しない。
// - refresh 自身の 401 で refresh を呼ぶと無限ループになる。
// - logout はそもそも認証エラーにならないが、対象外として明示しておく。
const AUTH_ENDPOINTS = new Set([
  "/auth/login",
  "/auth/signup",
  "/auth/refresh",
  "/auth/logout",
]);

// refreshPromise は進行中の refresh リクエストです（single-flight の実体）。
// null は「refresh が走っていない」状態を表します。
let refreshPromise: Promise<boolean> | null = null;

// refreshSession は POST /api/auth/refresh を single-flight で実行し、成功可否を返します。
// 新しいアクセストークン / リフレッシュトークンは httpOnly Cookie（Set-Cookie）で貼り替わるため、
// JS 側で保持するものはありません。
function refreshSession(): Promise<boolean> {
  refreshPromise ??= fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      // 完了後に解放し、次の期限切れ時に新しい refresh を実行できるようにします。
      // await 中の他の呼び出し元は解放後も同じ settled Promise から結果を受け取れます。
      refreshPromise = null;
    });
  return refreshPromise;
}

// rawApiFetch は /api プレフィックス付きの素の fetch です（リトライ判断は apiFetch が行う）。
function rawApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api${path}`, {
    // 同一オリジンのため Cookie は自動送信されるが、明示しておく。
    credentials: "same-origin",
    ...init,
    headers: {
      // body なしのリクエスト（logout 等）に Content-Type: application/json を付けると
      // Fastify が「空の JSON body」として 400 を返すため、body があるときだけ付けます。
      ...(init?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
}

// apiFetch は /api プレフィックス付きで API を呼び、JSON を返します。
// 204 No Content（logout）は null を返します。
// 401 の場合は silent refresh を 1 回だけ試み、成功したら元のリクエストを 1 回リトライします。
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  let response = await rawApiFetch(path, init);

  // アクセストークン期限切れの可能性がある 401 だけを refresh + リトライの対象にします。
  if (response.status === 401 && !AUTH_ENDPOINTS.has(path)) {
    const refreshed = await refreshSession();
    if (refreshed) {
      // 新しいアクセストークン Cookie が貼り替わった状態で、元のリクエストを 1 回だけ再実行します。
      response = await rawApiFetch(path, init);
    }
    // refresh 失敗時は元の 401 応答をそのまま下の共通エラー処理へ流します（未ログインとして扱う）。
  }

  if (response.status === 204) {
    return null;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    // NestJS の message は string | string[] のため、表示用に 1 本の文字列へ潰す。
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? Array.isArray(body.message)
          ? body.message.join(", ")
          : String(body.message)
        : `request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  return body as T;
}

// AuthenticatedUser は GET /auth/me が返す公開ユーザー情報です（backend の auth.types.ts と対応）。
export interface AuthenticatedUser {
  userId: string;
  email: string;
  createdAt: string;
}
