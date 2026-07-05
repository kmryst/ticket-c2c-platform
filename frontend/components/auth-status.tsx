// ファイル概要:
// このファイルはヘッダー右側の認証状態表示です（Issue #144）。
// httpOnly Cookie はサーバーコンポーネントの外部 fetch には自動で付かないため、
// ブラウザから同一オリジンの /api/auth/me を呼ぶ client component として実装します。

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, AuthenticatedUser } from "@/lib/api";

export default function AuthStatus() {
  const router = useRouter();
  // undefined は「確認中」、null は「未ログイン」を表します。
  const [user, setUser] = useState<AuthenticatedUser | null | undefined>(
    undefined,
  );

  useEffect(() => {
    // unmount 後の setState を避けるためのフラグです。
    let cancelled = false;
    apiFetch<AuthenticatedUser>("/auth/me")
      .then((me) => {
        if (!cancelled) {
          setUser(me);
        }
      })
      .catch(() => {
        // 401（未ログイン・期限切れ）は正常系として未ログイン表示にします。
        if (!cancelled) {
          setUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
    // SSR ページの認証依存表示も更新されるようルートを再取得します。
    router.refresh();
  }

  if (user === undefined) {
    return <span className="text-sm opacity-50">…</span>;
  }

  if (user === null) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <Link href="/login" className="hover:underline">
          ログイン
        </Link>
        <Link
          href="/signup"
          className="rounded bg-foreground px-3 py-1.5 text-background hover:opacity-80"
        >
          新規登録
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span data-testid="current-user-email" className="opacity-70">
        {user.email}
      </span>
      <button
        type="button"
        onClick={() => void logout()}
        className="rounded border border-current px-3 py-1.5 hover:opacity-70"
      >
        ログアウト
      </button>
    </div>
  );
}
