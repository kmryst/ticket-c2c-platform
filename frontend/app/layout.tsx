// ファイル概要:
// このファイルは全ページ共通のルートレイアウトです（Next.js App Router）。
// メタデータ（タイトル等）と Tailwind のグローバル CSS を適用します。
// フォントはビルド環境のネットワーク依存を避けるため、外部フォントを使わず
// システムフォントスタック（globals.css）に統一します。

import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/header";

export const metadata: Metadata = {
  title: "ticket-c2c",
  description: "C2C ticket sales platform (PoC)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Header />
        {children}
      </body>
    </html>
  );
}
