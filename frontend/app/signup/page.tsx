// ファイル概要:
// このファイルはサインアップページです（Issue #144）。フォーム本体は AuthForm（client）に委譲します。
// signup 成功時も API が Set-Cookie を発行するため、そのままログイン済みになります。

import { Suspense } from "react";
import Link from "next/link";
import AuthForm from "@/components/auth-form";

export const metadata = { title: "新規登録 | ticket-c2c" };

export default function SignupPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-6 px-4 py-12">
      <h1 className="text-2xl font-bold">新規登録</h1>
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
      <p className="text-sm opacity-70">
        アカウントがある場合は{" "}
        <Link href="/login" className="underline">
          ログイン
        </Link>
      </p>
    </main>
  );
}
