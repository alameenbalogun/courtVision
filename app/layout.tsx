import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker';

export const metadata: Metadata = {
  title: 'CourtVision — tennis replay & experimental line calls',
  description:
    'Record a tennis match on your phone, save the last 20 seconds after a disputed point, and review footage frame by frame. AI line calls are experimental estimates.',
  manifest: '/manifest.webmanifest',
  applicationName: 'CourtVision',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'CourtVision' },
  icons: { icon: '/icon.svg', apple: '/icon-192.png' },
};

export const viewport: Viewport = {
  themeColor: '#080b09',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                CV
              </span>
              <span className="brand-text">
                CourtVision
                <small>Replay · Record · Assist</small>
              </span>
            </Link>
            <nav className="nav">
              <Link href="/" className="nav-link">
                Sessions
              </Link>
              <Link href="/#how" className="nav-link">
                How it works
              </Link>
              <Link href="/record" className="nav-link nav-link--cta">
                Record a match
              </Link>
            </nav>
          </div>
        </header>
        <main className="page">{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <span>
              CourtVision prototype · live recording and replay first, automated officiating last.
            </span>
            <span>
              AI line calls are estimates and are never official decisions. Footage stays on this device
              until you export it.
            </span>
          </div>
        </footer>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
