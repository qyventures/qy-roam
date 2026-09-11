/** @type {import('next').NextConfig} */
// Next's development runtime uses eval-backed source maps, but the optimized
// standalone server does not. Keep that development-only exception out of the
// customer-facing CSP: an XSS defect should not also gain an eval primitive in
// production.
const scriptSources = [
  "'self'",
  "'unsafe-inline'",
  ...(process.env.NODE_ENV === 'development' ? ["'unsafe-eval'"] : []),
  'https://connect.facebook.net',
].join(' ');

const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  compress: true,
  async headers() {
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      {
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "form-action 'self' https://checkout.stripe.com",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "img-src 'self' data: https://www.facebook.com https://*.fbcdn.net",
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          `script-src ${scriptSources}`,
          "connect-src 'self' https://api.stripe.com https://*.supabase.co https://www.facebook.com https://connect.facebook.net",
          "frame-src https://checkout.stripe.com",
          'upgrade-insecure-requests',
        ].join('; '),
      },
    ];

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, nosnippet' },
        ],
      },
      // Checkout redirects carry an unguessable Stripe session reference in
      // the URL. These pages retrieve current payment and fulfilment state,
      // so a browser, proxy, or search crawler must not retain a prior
      // traveller's confirmation or status response.
      {
        source: '/success',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0, private' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, nosnippet' },
        ],
      },
      {
        source: '/booking',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0, private' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, nosnippet' },
        ],
      },
      {
        source: '/admin/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, nosnippet' },
        ],
      },
    ];
  },
};

export default nextConfig;
