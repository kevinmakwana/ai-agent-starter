import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Acme Shop · Support Agent',
  description: 'Tool-calling customer-support agent with traces and human approval',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
