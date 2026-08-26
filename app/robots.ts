import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/']
      }
    ],
    sitemap: 'https://qyroam.com/sitemap.xml'
  };
}
