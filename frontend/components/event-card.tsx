// ファイル概要:
// このファイルはイベント一覧・検索結果で使う共通カードです（Issue #145）。

import Link from "next/link";
import { EventSummary } from "@/lib/events";

export default function EventCard({ event }: { event: EventSummary }) {
  const soldOut = event.remainingQuantity <= 0;
  return (
    <Link
      href={`/events/${event.eventId}`}
      data-testid="event-card"
      className="flex flex-col gap-1 rounded border border-black/10 p-4 hover:border-black/40 dark:border-white/15 dark:hover:border-white/50"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{event.title}</h2>
        {soldOut ? (
          <span className="rounded bg-red-600/10 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">
            売り切れ
          </span>
        ) : (
          <span className="rounded bg-emerald-600/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
            残り {event.remainingQuantity} 枚
          </span>
        )}
      </div>
      <p className="text-sm opacity-70">
        {event.eventType} ・{" "}
        {new Date(event.startsAt).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        })}
      </p>
    </Link>
  );
}
