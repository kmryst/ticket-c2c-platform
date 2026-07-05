// ファイル概要:
// このファイルはログインページです（Issue #144）。フォーム本体は AuthForm（client）に委譲します。

import { Suspense } from "react";
import Link from "next/link";
import AuthForm from "@/components/auth-form";

export const metadata = { title: "ログイン | ticket-c2c" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-6 px-4 py-12">
      <h1 className="text-2xl font-bold">ログイン</h1>
      {/* useSearchParams を使う client component は Suspense 境界が必要です。 */}
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
      <p className="text-sm opacity-70">
        アカウントがない場合は{" "}
        <Link href="/signup" className="underline">
          新規登録
        </Link>
      </p>
    </main>
  );
}
