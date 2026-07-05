// ファイル概要:
// このファイルはイベント登録フォームです（Issue #145）。
// POST /api/events を呼び、成功したら作成イベントの詳細ページへ遷移します。

"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { EventSummary } from "@/lib/events";
import { useHydrated } from "@/lib/use-hydrated";

export default function EventForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const lat = String(form.get("latitude") ?? "");
      const lon = String(form.get("longitude") ?? "");
      const created = await apiFetch<EventSummary>("/events", {
        method: "POST",
        body: JSON.stringify({
          title: form.get("title"),
          eventType: form.get("eventType"),
          // datetime-local の値（秒なし）を ISO 8601 へ揃えます。
          startsAt: new Date(String(form.get("startsAt"))).toISOString(),
          latitude: lat ? Number(lat) : null,
          longitude: lon ? Number(lon) : null,
          totalQuantity: Number(form.get("totalQuantity")),
        }),
      });
      router.push(`/events/${created!.eventId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "通信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25";

  return (
    <form
      method="POST"
      data-hydrated={hydrated ? "true" : undefined}
      onSubmit={(e) => void onSubmit(e)}
      className="grid w-full max-w-lg grid-cols-2 gap-4"
    >
      <label className="col-span-2 flex flex-col gap-1 text-sm">
        タイトル
        <input name="title" required maxLength={200} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        種別（eventType）
        <input name="eventType" required maxLength={50} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        開催日時
        <input name="startsAt" type="datetime-local" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        緯度（任意）
        <input name="latitude" type="number" step="any" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        経度（任意）
        <input name="longitude" type="number" step="any" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        販売枚数
        <input
          name="totalQuantity"
          type="number"
          min={1}
          required
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className="col-span-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || !hydrated}
        className="col-span-2 rounded bg-foreground px-4 py-2 text-background hover:opacity-80 disabled:opacity-50"
      >
        登録する
      </button>
    </form>
  );
}
