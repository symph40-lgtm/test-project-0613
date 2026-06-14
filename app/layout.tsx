import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "스탁가드 — 리스크 관제",
  description:
    "시장이 흔들릴 때 숫자와 원칙으로 매매 행동을 붙잡아주는 침착한 리스크 가드. (목업)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
