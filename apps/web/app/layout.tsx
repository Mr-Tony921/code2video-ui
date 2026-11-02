import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SenseNova Coding Video & 3D Blockout',
  description: 'AI 视频创作 Agent 试用平台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
