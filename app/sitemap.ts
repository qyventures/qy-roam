import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://qyroam.com';
  const pages = [
    { path: '', priority: 1, changeFrequency: 'weekly' as const },
    { path: '/esim', priority: 0.95, changeFrequency: 'weekly' as const },
    { path: '/faq', priority: 0.8, changeFrequency: 'monthly' as const },
    { path: '/privacy', priority: 0.4, changeFrequency: 'yearly' as const },
    { path: '/terms', priority: 0.4, changeFrequency: 'yearly' as const }
  ];

  return pages.map((page) => ({
    url: `${base}${page.path}`,
    lastModified: new Date(),
    changeFrequency: page.changeFrequency,
    priority: page.priority
  }));
}
