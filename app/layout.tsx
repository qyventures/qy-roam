import './styles.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'QY Roam | Pocket WiFi for Singapore Travellers',
  description: 'Affordable pocket WiFi rental with courier delivery and easy return for travellers departing Singapore.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="wrap header-inner">
            <a href="/" className="brand">QY Roam</a>
            <nav>
              <a href="#plans">Plans</a>
              <a href="#how">How it works</a>
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
            <div><a href="/privacy">Privacy</a><br/><a href="/terms">Terms</a></div>
          </div>
        </footer>
      </body>
    </html>
  );
}
