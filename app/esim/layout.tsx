import type { Metadata } from 'next';
import { ESIM_PLANS } from '../../lib/esimPlans';

export const metadata: Metadata = {
  title: 'Travel eSIM Singapore | Japan, Taiwan, USA & Europe',
  description: 'Buy QY Roam travel eSIMs online before you fly. QR-code setup, Singapore support and launch pricing benchmarked 15% below verified comparable Changi Recommends public prices.',
  alternates: { canonical: '/esim' },
  openGraph: {
    type: 'website',
    url: 'https://qyroam.com/esim',
    title: 'QY Roam Travel eSIM | Buy Online Before You Fly',
    description: 'Travel eSIM plans with QR-code setup, secure checkout and Singapore-based support.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QY Roam Travel eSIM',
    description: 'Travel eSIM plans with QR-code setup, secure checkout and Singapore-based support.'
  }
};

export default function EsimLayout({ children }: { children: React.ReactNode }) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'QY Roam Travel eSIM Plans',
    url: 'https://qyroam.com/esim',
    itemListElement: ESIM_PLANS.map((plan, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Product',
        name: `QY Roam ${plan.destination} Travel eSIM`,
        description: `${plan.days} days · ${plan.data}`,
        brand: { '@type': 'Brand', name: 'QY Roam' },
        offers: {
          '@type': 'Offer',
          priceCurrency: 'SGD',
          price: plan.qyPriceSgd.toFixed(2),
          availability: 'https://schema.org/InStock',
          url: 'https://qyroam.com/esim'
        }
      }
    }))
  };

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
    {children}
  </>;
}
