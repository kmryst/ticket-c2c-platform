// ファイル概要:
// このファイルは全ページ共通のヘッダーです（Issue #144）。
// ナビゲーションと認証状態表示（AuthStatus）を持ちます。

import Link from "next/link";
import AuthStatus from "./auth-status";

export default function Header() {
  return (
    <header className="border-b border-black/10 dark:border-white/15">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3">
        <nav className="flex items-center gap-4">
          <Link href="/" className="font-bold tracking-tight">
            ticket-c2c
          </Link>
          <Link href="/search" className="text-sm hover:underline">
            検索
          </Link>
          <Link href="/events/new" className="text-sm hover:underline">
            イベント登録
          </Link>
        </nav>
        <AuthStatus />
      </div>
    </header>
  );
}
