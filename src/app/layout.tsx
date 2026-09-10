import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PAXAFE Integration API',
  description: 'Tive webhook ingestion, normalisation and persistence for cold chain telemetry.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
