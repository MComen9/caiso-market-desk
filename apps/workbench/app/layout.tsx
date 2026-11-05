import type { Metadata } from "next";
import "./globals.css";
import "./market-workspace.css";

export const metadata: Metadata = {
  title: "CAISO · 电力市场研究台",
  description: "连接 CAISO OASIS 与 Today’s Outlook，查看节点价格、负荷与风光预测、储能、供需展望和可追溯数据。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
