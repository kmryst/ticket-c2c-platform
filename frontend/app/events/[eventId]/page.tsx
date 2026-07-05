// ファイル概要:
// このファイルはイベント詳細 + 購入ページです（Issue #145）。
// イベント情報は SSR で取得し、購入フォームは client component（purchase-form）に委譲します。

import { notFound } from "next/navigation";
import { findEvent } from "@/lib/events";
import PurchaseForm from "@/components/purchase-form";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const event = await findEvent(eventId);

  if (!event) {
    notFound();
  }

  const soldOut = event.remainingQuantity <= 0;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">{event.title}</h1>
        <p className="text-sm opacity-70">
          {event.eventType} ・{" "}
          {new Date(event.startsAt).toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
          })}
        </p>
        <p data-testid="remaining-quantity" className="text-sm">
          {soldOut ? "売り切れ" : `残り ${event.remainingQuantity} / ${event.totalQuantity} 枚`}
        </p>
      </div>
      <PurchaseForm eventId={event.eventId} soldOut={soldOut} />
    </main>
  );
}
