// ファイル概要:
// このファイルはイベント検索ページです（Issue #145）。
// フォームは GET 送信（JS 不要）で searchParams を受け取り、SSR で GET /events/search を呼びます。
// AWS では OpenSearch、ローカルでは DB フォールバックが検索を担います。

import EventCard from "@/components/event-card";
import { searchEvents, SearchQuery } from "@/lib/events";

export const metadata = { title: "イベント検索 | ticket-c2c" };
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query: SearchQuery = {
    eventType: asString(params.eventType),
    date: asString(params.date),
    lat: asString(params.lat),
    lon: asString(params.lon),
    radiusKm: asString(params.radiusKm),
  };
  const hasQuery = Object.values(query).some((value) => value);
  const results = hasQuery ? await searchEvents(query) : null;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">イベント検索</h1>
      <form method="GET" className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          種別（eventType）
          <input
            name="eventType"
            defaultValue={query.eventType}
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          開催日（YYYY-MM-DD）
          <input
            name="date"
            defaultValue={query.date}
            placeholder="2026-07-10"
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          緯度（lat）
          <input
            name="lat"
            defaultValue={query.lat}
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          経度（lon）
          <input
            name="lon"
            defaultValue={query.lon}
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          半径 km（radiusKm）
          <input
            name="radiusKm"
            defaultValue={query.radiusKm}
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="rounded bg-foreground px-4 py-2 text-background hover:opacity-80"
          >
            検索
          </button>
        </div>
      </form>
      {results !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm opacity-70">検索結果: {results.length} 件</h2>
          {results.map((event) => (
            <EventCard key={event.eventId} event={event} />
          ))}
        </section>
      )}
    </main>
  );
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
