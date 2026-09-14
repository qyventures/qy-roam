import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Checkout confirmation and booking-status URLs carry an unguessable
        // Stripe Checkout Session reference. They already emit noindex and
        // no-referrer headers, but excluding them here keeps compliant
        // crawlers from requesting, retaining, or surfacing those capability
        // URLs when a customer shares a link publicly.
        disallow: ['/admin', '/api/', '/success', '/booking']
      }
    ],
    sitemap: 'https://qyroam.com/sitemap.xml'
  };
}
