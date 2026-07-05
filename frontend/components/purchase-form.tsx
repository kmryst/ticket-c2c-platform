// ファイル概要:
// このファイルはチケット購入フォームです（Issue #145）。
// POST /api/events/:eventId/purchases を httpOnly Cookie 認証で呼び、
// confirmed / rejected(sold_out) の結果を表示します。
// requestId（idempotency key）は送信ごとに自動生成します。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

// PurchaseResult は backend の購入 API 応答です（purchase.types.ts と対応）。
interface PurchaseResult {
  purchaseId: string | null;
  eventId: string;
  buyerId: string;
  quantity: number;
  status: "confirmed" | "rejected";
  rejectionReason: string | null;
  remainingQuantity: number | null;
}

export default function PurchaseForm({
  eventId,
  soldOut,
}: {
  eventId: string;
  soldOut: boolean;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState<PurchaseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function purchase() {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const purchaseResult = await apiFetch<PurchaseResult>(
        `/events/${eventId}/purchases`,
        {
          method: "POST",
          body: JSON.stringify({
            quantity,
            // 同じリクエストの再送を冪等にするための idempotency key。
            requestId: crypto.randomUUID(),
          }),
        },
      );
      setResult(purchaseResult);
      // 残枚数の SSR 表示を最新化します。
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // 未ログインはログインページへ誘導し、戻り先として現在のページを渡します。
        router.push(`/login?next=/events/${eventId}`);
        return;
      }
      setError(e instanceof ApiError ? e.message : "通信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex w-full max-w-sm flex-col gap-4">
      <h2 className="font-semibold">チケット購入</h2>
      <label className="flex flex-col gap-1 text-sm">
        枚数
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
        />
      </label>
      <button
        type="button"
        onClick={() => void purchase()}
        disabled={submitting}
        data-testid="purchase-button"
        className="rounded bg-foreground px-4 py-2 text-background hover:opacity-80 disabled:opacity-50"
      >
        購入する
      </button>
      {result?.status === "confirmed" && (
        <p
          data-testid="purchase-confirmed"
          className="rounded bg-emerald-600/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"
        >
          購入が確定しました（購入 ID: {result.purchaseId}、残り{" "}
          {result.remainingQuantity} 枚）
        </p>
      )}
      {result?.status === "rejected" && (
        <p
          data-testid="purchase-rejected"
          className="rounded bg-red-600/10 p-3 text-sm text-red-600 dark:text-red-400"
        >
          購入できませんでした（理由: {result.rejectionReason ?? "不明"}）
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {soldOut && !result && (
        <p className="text-sm opacity-70">このイベントは売り切れです。</p>
      )}
    </section>
  );
}
