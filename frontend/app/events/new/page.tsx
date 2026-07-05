// ファイル概要:
// このファイルはイベント登録ページです（Issue #145）。フォーム本体は client component に委譲します。

import EventForm from "@/components/event-form";

export const metadata = { title: "イベント登録 | ticket-c2c" };

export default function NewEventPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">イベント登録</h1>
      <EventForm />
    </main>
  );
}
