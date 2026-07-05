// ファイル概要:
// このファイルはログイン / サインアップ共通のフォームです（Issue #144）。
// 成功すると API が httpOnly Cookie（access_token）を Set-Cookie で発行するため、
// フロントエンドはトークンを一切保存しません（ADR-0011 決定 3）。

"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { useHydrated } from "@/lib/use-hydrated";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      // 購入ページ等から誘導された場合は元のページへ戻します。
      const next = searchParams.get("next");
      router.push(next && next.startsWith("/") ? next : "/");
      // ヘッダーの認証状態と SSR 表示を更新します。
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        // 代表的なエラーは日本語メッセージへ変換します（409: メール重複、401: 資格情報不一致）。
        if (e.status === 409) {
          setError("このメールアドレスは既に登録されています");
        } else if (e.status === 401) {
          setError("メールアドレスまたはパスワードが違います");
        } else {
          setError(e.message);
        }
      } else {
        setError("通信に失敗しました");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      // hydration 前のネイティブ submit（資格情報が URL に載る GET）を避けるため method を明示します。
      method="POST"
      data-hydrated={hydrated ? "true" : undefined}
      onSubmit={(e) => void onSubmit(e)}
      className="flex w-full max-w-sm flex-col gap-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        メールアドレス
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        パスワード
        <input
          type="password"
          name="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || !hydrated}
        className="rounded bg-foreground px-4 py-2 text-background hover:opacity-80 disabled:opacity-50"
      >
        {mode === "login" ? "ログイン" : "登録する"}
      </button>
    </form>
  );
}
