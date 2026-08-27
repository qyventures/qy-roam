import './styles.css';
import type { Metadata } from 'next';
import MetaConsent from '@/components/MetaConsent';

export const metadata: Metadata = {
  metadataBase: new URL('https://qyroam.com'),
  title: {
    default: 'QY Roam | Travel eSIM & Pocket WiFi',
    template: '%s | QY Roam'
  },
  description: 'Affordable travel eSIM and pocket WiFi for travellers departing Singapore, with secure online checkout and local support.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: 'https://qyroam.com',
    siteName: 'QY Roam',
    title: 'QY Roam | Travel eSIM & Pocket WiFi',
    description: 'Travel eSIM and pocket WiFi with launch promotions, secure checkout and Singapore-based support.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QY Roam | Travel eSIM & Pocket WiFi',
    description: 'Travel eSIM and pocket WiFi with launch promotions, secure checkout and Singapore-based support.'
  },
  robots: { index: true, follow: true }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="wrap header-inner">
            <a href="/" className="brand">QY Roam</a>
            <nav>
              <a href="/esim">eSIM</a>
              <a href="/#plans">Pocket WiFi</a>
              <a href="/#how">How it works</a>
              <a href="/faq">FAQ</a>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
            </nav>
          </div>
        </header>
        {children}
        <footer>
          <div className="wrap footer-grid">
            <div><strong>QY Roam</strong><br/>Travel eSIM & Pocket WiFi<br/>A service by QY Venture Pte. Ltd.</div>
            <div>Customer support<br/><a href="tel:+6580327183">+65 8032 7183</a></div>
            <div><a href="/esim">Travel eSIM</a><br/><a href="/#plans">Pocket WiFi</a><br/><a href="/faq">FAQ</a><br/><a href="/privacy">Privacy</a><br/><a href="/terms">Terms</a></div>
          </div>
        </footer>
        <MetaConsent />
      </body>
    </html>
  );
}
