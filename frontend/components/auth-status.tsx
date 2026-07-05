// ファイル概要:
// このファイルはヘッダー右側の認証状態表示です（Issue #144）。
// httpOnly Cookie はサーバーコンポーネントの外部 fetch には自動で付かないため、
// ブラウザから同一オリジンの /api/auth/me を呼ぶ client component として実装します。

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch, AuthenticatedUser } from "@/lib/api";

export default function AuthStatus() {
  const router = useRouter();
  // login / signup 後のクライアント遷移でヘッダーは再マウントされないため、
  // パス変更をトリガーに認証状態を取り直します。
  const pathname = usePathname();
  // undefined は「確認中」、null は「未ログイン」を表します。
  const [user, setUser] = useState<AuthenticatedUser | null | undefined>(
    undefined,
  );
  // logout 直後に「logout 前に発行された /auth/me」が遅れて解決して表示が戻るのを防ぐため、
  // logout で version を進めて effect を再実行（進行中 fetch は cleanup で無効化）します。
  const [version, setVersion] = useState(0);

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
  }, [pathname, version]);

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    // Cookie 破棄後に認証状態を取り直します（effect の cleanup が進行中の古い fetch を無効化）。
    setVersion((current) => current + 1);
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
