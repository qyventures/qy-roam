import type { Metadata } from 'next';
import { ESIM_PLANS, esimPromoIsActive } from '../../lib/esimPlans';

// Offer availability is time-bound. Render this subtree per request so search
// metadata cannot remain frozen as in-stock after the approved sales window
// ends while the checkout has already failed closed.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Travel eSIM Singapore | Japan, Taiwan, USA & Europe',
  description: 'Explore QY Roam travel eSIM options with QR-code setup and Singapore support. Current online availability and pricing are shown on the eSIM page.',
  alternates: { canonical: '/esim' },
  openGraph: {
    type: 'website',
    url: 'https://qyroam.com/esim',
    title: 'QY Roam Travel eSIM | Plans & Current Availability',
    description: 'Travel eSIM plan information with QR-code setup, current online availability and Singapore-based support.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QY Roam Travel eSIM',
    description: 'Travel eSIM plan information with QR-code setup, current online availability and Singapore-based support.'
  }
};

export default function EsimLayout({ children }: { children: React.ReactNode }) {
  const offerActive = esimPromoIsActive();
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
        offers: offerActive ? {
          '@type': 'Offer',
          priceCurrency: 'SGD',
          price: plan.qyPriceSgd.toFixed(2),
          availability: 'https://schema.org/InStock',
          url: 'https://qyroam.com/esim'
        } : undefined
      }
    }))
  };

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
    {children}
  </>;
}
