import './styles.css';
import type { Metadata } from 'next';
import MetaConsent from '@/components/MetaConsent';

export const metadata: Metadata = {
  metadataBase: new URL('https://qyroam.com'),
  title: {
    default: 'QY Roam | Pocket WiFi for Singapore Travellers',
    template: '%s | QY Roam'
  },
  description: 'Affordable pocket WiFi rental with courier delivery and easy return for travellers departing Singapore.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: 'https://qyroam.com',
    siteName: 'QY Roam',
    title: 'QY Roam | Pocket WiFi for Singapore Travellers',
    description: 'Affordable pocket WiFi rental with courier delivery and easy return for travellers departing Singapore.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QY Roam | Pocket WiFi for Singapore Travellers',
    description: 'Affordable pocket WiFi rental with courier delivery and easy return for travellers departing Singapore.'
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
              <a href="/#plans">Plans</a>
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
            <div><strong>QY Roam</strong><br/>A service by QY Venture Pte. Ltd.</div>
            <div>Customer support<br/><a href="tel:+6580327183">+65 8032 7183</a></div>
            <div><a href="/faq">FAQ</a><br/><a href="/privacy">Privacy</a><br/><a href="/terms">Terms</a></div>
          </div>
        </footer>
        <MetaConsent />
      </body>
    </html>
  );
}
