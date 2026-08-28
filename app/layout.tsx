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
  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type':'Organization', name:'QY Venture Pte. Ltd.', url:'https://qyroam.com', telephone:'+65 8032 7183', address:{'@type':'PostalAddress',addressCountry:'SG'} },
      { '@type':'WebSite', name:'QY Roam', url:'https://qyroam.com' },
      { '@type':'Service', name:'QY Roam Travel Connectivity', serviceType:'Travel eSIM and Pocket WiFi rental', provider:{'@type':'Organization',name:'QY Venture Pte. Ltd.'}, areaServed:'Singapore', url:'https://qyroam.com' }
    ]
  };
  return (
    <html lang="en">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify(schema)}} />
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
        <a
          className="whatsapp-float"
          href="https://wa.me/6580327183?text=Hi%20QY%20Roam%2C%20I%20need%20help%20with%20a%20travel%20eSIM%20or%20Pocket%20WiFi."
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Chat with QY Roam on WhatsApp"
        >
          <svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M19.11 17.58c-.27-.14-1.6-.79-1.85-.88-.25-.09-.43-.14-.61.14-.18.27-.7.88-.86 1.06-.16.18-.32.2-.59.07-.27-.14-1.15-.42-2.19-1.35-.81-.72-1.36-1.62-1.52-1.9-.16-.27-.02-.42.12-.56.12-.12.27-.32.41-.48.14-.16.18-.27.27-.45.09-.18.05-.34-.02-.48-.07-.14-.61-1.47-.84-2.01-.22-.53-.45-.46-.61-.47h-.52c-.18 0-.48.07-.72.34-.25.27-.95.93-.95 2.26s.97 2.62 1.11 2.8c.14.18 1.91 2.91 4.62 4.08.65.28 1.15.45 1.54.57.65.21 1.24.18 1.71.11.52-.08 1.6-.65 1.83-1.29.23-.63.23-1.17.16-1.29-.07-.11-.25-.18-.52-.32z"/><path fill="currentColor" d="M16.03 3.2c-7.05 0-12.78 5.71-12.78 12.75 0 2.25.59 4.45 1.7 6.39L3.14 28.8l6.62-1.74a12.8 12.8 0 0 0 6.26 1.59h.01c7.04 0 12.77-5.72 12.77-12.76 0-3.41-1.33-6.61-3.74-9.02A12.67 12.67 0 0 0 16.03 3.2zm0 23.3h-.01a10.6 10.6 0 0 1-5.4-1.48l-.39-.23-3.93 1.03 1.05-3.83-.25-.39a10.56 10.56 0 0 1-1.63-5.65c0-5.82 4.74-10.56 10.57-10.56 2.82 0 5.47 1.1 7.46 3.1a10.48 10.48 0 0 1 3.09 7.46c0 5.82-4.74 10.55-10.56 10.55z"/></svg>
          <span>WhatsApp</span>
        </a>
        <MetaConsent />
      </body>
    </html>
  );
}
