// ファイル概要:
// このファイルはブラウザから API を呼ぶための共通 fetch ヘルパーです（ADR-0011）。
// ブラウザは常に同一オリジンの /api/* を叩き、AWS では CloudFront が ALB（API）へ、
// ローカル・E2E では next.config.ts の rewrite がバックエンドへ転送します。
// 認証は httpOnly Cookie（access_token）で行うため、トークンを JS で扱いません。

// ApiError は API のエラー応答（NestJS の { statusCode, message } 形式）を画面へ伝える例外です。
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// apiFetch は /api プレフィックス付きで API を呼び、JSON を返します。
// 204 No Content（logout）は null を返します。
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const response = await fetch(`/api${path}`, {
    // 同一オリジンのため Cookie は自動送信されるが、明示しておく。
    credentials: "same-origin",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

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
