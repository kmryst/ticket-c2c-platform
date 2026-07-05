// ファイル概要:
// このファイルはトップページ（イベント一覧の SSR）です（Issue #145）。
// GET /events をサーバー側で取得し、開催日順の一覧を表示します。

import EventCard from "@/components/event-card";
import { fetchEvents } from "@/lib/events";

// API_BASE_URL を毎リクエスト参照するため動的レンダリングに固定します。
export const dynamic = "force-dynamic";

export default async function Home() {
  const events = await fetchEvents();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">イベント一覧</h1>
      {events.length === 0 ? (
        <p className="text-sm opacity-70">
          イベントはまだありません。「イベント登録」から作成できます。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((event) => (
            <EventCard key={event.eventId} event={event} />
          ))}
        </div>
      )}
    </main>
  );
}
