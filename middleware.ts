import { NextRequest, NextResponse } from 'next/server';
import { getAdminCredentials } from './lib/runtimeConfig';

function safeEqual(a: string, b: string) {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isUnsafeMethod(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/**
 * Basic Auth proves who the operator is, but browsers can retain those
 * credentials and attach them to a cross-site form submission. Reject an
 * explicitly cross-site mutation, and require any supplied Origin to match
 * the API origin. Requests from the admin UI are same-origin; non-browser
 * recovery clients that do not send browser provenance headers remain usable.
 */
function isTrustedAdminMutation(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/api/admin') || !isUnsafeMethod(req.method)) return true;
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;

  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === req.nextUrl.origin;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/admin') && !req.nextUrl.pathname.startsWith('/api/admin')) {
    return NextResponse.next();
  }

  const { user, password: pass } = getAdminCredentials();
  if (!user || !pass) return new NextResponse('Admin access is not configured.', { status: 503 });

  // Check browser request provenance before credentials so a cross-site page
  // cannot use an authenticated admin session to create orders, move stock,
  // change fulfilment state, or retry customer/analytics deliveries.
  if (!isTrustedAdminMutation(req)) {
    return new NextResponse('Cross-site admin mutation rejected.', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPass = decoded.slice(separator + 1);
        if (safeEqual(givenUser, user) && safeEqual(givenPass, pass)) return NextResponse.next();
      }
    } catch {}
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="QY Roam Admin"', 'Cache-Control': 'no-store' }
  });
}

export const config = { matcher: ['/admin/:path*', '/api/admin/:path*'] };
