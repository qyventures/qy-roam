import { NextRequest, NextResponse } from 'next/server';
import { getAdminCredentials, hasRequiredAdminCredentials } from './lib/runtimeConfig';
import { ADMIN_AUTH_FAILURE_WINDOW_MS, failedAdminAuthGloballyLimited, failedAdminAuthLimited } from './lib/adminAuthRateLimit';
import { ADMIN_MUTATION_HEADER, ADMIN_MUTATION_HEADER_VALUE } from './lib/adminMutation';
import { validStripeCheckoutSessionId } from './lib/stripeSessionId';
import { CONFIRMATION_RATE_LIMIT_WINDOW_MS, confirmationClientLimited, confirmationGloballyLimited } from './lib/confirmationRateLimit';

// Reverse proxies normally impose a header limit, but authentication is a
// public edge of the operations surface and must retain a bounded CPU/memory
// cost when the application is reached through a different proxy. This still
// leaves substantially more room than a normal username/password pair.
const MAX_BASIC_AUTH_HEADER_LENGTH = 8_192;
const MAX_BASIC_AUTH_DECODED_LENGTH = 4_096;
// The success and booking pages retrieve a Stripe Checkout Session and can
// also query the paid-order ledger. Unlike API checkout rate limits, this
// boundary must run before a server component is rendered; otherwise even a
// rejected page has already consumed provider work. Keep its client registry
// bounded so rotating clients cannot turn the defence itself into a second
// denial-of-service vector. This is an instance-local overload guard, matching
// the standalone single-process production deployment.
function isConfirmationLookup(pathname: string) {
  return pathname === '/success' || pathname === '/booking';
}

function isProviderBackedConfirmationLookup(req: NextRequest) {
  if (!isConfirmationLookup(req.nextUrl.pathname)) return false;
  // The page components reject missing, repeated, malformed, and oversized
  // Checkout Session references before making a Stripe request. Keep the
  // shared overload budget on that identical boundary: otherwise a crawler
  // or attacker can exhaust every real customer's confirmation capacity by
  // repeatedly opening the bare /success or /booking route while consuming
  // no provider work at all. URLSearchParams#get returns one string for a
  // repeated key, so reject duplicates explicitly to match App Router's
  // string[] validation rather than treating the first value as authority.
  const sessionIds = req.nextUrl.searchParams.getAll('session_id');
  return sessionIds.length === 1 && Boolean(validStripeCheckoutSessionId(sessionIds[0]));
}

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

function authenticatedAdminResponse() {
  // Admin pages and APIs contain customer identities, order capabilities,
  // inventory custody, and accounting records. Apply this at the auth
  // boundary rather than relying on every current and future route to
  // remember its own cache policy: successful server renders and early API
  // validation responses must never be retained by a browser shared cache or
  // intermediary after Basic Auth has granted access.
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store, max-age=0, private');
  return response;
}

/**
 * Basic Auth proves who the operator is, but browsers can retain those
 * credentials and attach them to a cross-site form submission. Reject an
 * explicitly cross-site mutation, and require any supplied Origin or Referer
 * to match the API origin. Requests from the admin UI are same-origin. A
 * non-browser recovery client without browser provenance must send the
 * explicit admin-mutation marker used by the first-party UI; unlike a simple
 * HTML form, an intentional API client can set that custom header.
 */
function isTrustedAdminMutation(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/api/admin') || !isUnsafeMethod(req.method)) return true;
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;

  const origin = req.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).origin === req.nextUrl.origin;
    } catch {
      return false;
    }
  }

  // Some browsers, privacy tools, and reverse proxies can omit Origin while
  // retaining Referer. A cross-site form can issue the bodyless POST used to
  // retry paid-order fulfilment/CAPI, and cached Basic Auth credentials may be
  // attached by the browser. Treat a supplied Referer as provenance too so
  // stripping only Origin cannot downgrade the same-origin check. Purposeful
  // non-browser recovery clients remain supported because they normally send
  // neither browser provenance header.
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === req.nextUrl.origin;
    } catch {
      return false;
    }
  }

  // Modern same-origin fetches normally carry at least one of the headers
  // above. When all provenance is absent, fail closed unless the caller opts
  // into the explicit API contract. This preserves CLI recovery without
  // leaving bodyless delivery-retry POSTs triggerable by a cross-site form in
  // a legacy/privacy-stripped browser with cached Basic Auth credentials.
  return req.headers.get(ADMIN_MUTATION_HEADER) === ADMIN_MUTATION_HEADER_VALUE;
}

export function middleware(req: NextRequest) {
  if (isConfirmationLookup(req.nextUrl.pathname)) {
    const providerBackedLookup = isProviderBackedConfirmationLookup(req);
    // Do not spend the instance-wide budget after this client has crossed its
    // own ceiling. This ordering preserves capacity for unrelated customers.
    if (providerBackedLookup && (confirmationClientLimited(req) || confirmationGloballyLimited())) {
      return new NextResponse('Order confirmation is busy. Please try again shortly.', {
        status: 429,
        headers: {
          'Cache-Control': 'no-store, max-age=0, private',
          'Retry-After': String(Math.ceil(CONFIRMATION_RATE_LIMIT_WINDOW_MS / 1000)),
          'X-Robots-Tag': 'noindex, nofollow, nosnippet',
          // Both routes carry an unguessable Checkout Session reference in
          // the query string. Preserve their normal no-referrer boundary on
          // overload responses as well as successful renders.
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
    return NextResponse.next();
  }

  if (!req.nextUrl.pathname.startsWith('/admin') && !req.nextUrl.pathname.startsWith('/api/admin')) {
    return NextResponse.next();
  }

  const { user, password: pass } = getAdminCredentials();
  if (!hasRequiredAdminCredentials() || !user || !pass) {
    return new NextResponse('Admin access is not configured securely.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

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
  if (auth?.startsWith('Basic ') && auth.length <= MAX_BASIC_AUTH_HEADER_LENGTH) {
    try {
      const decoded = atob(auth.slice(6));
      const separator = decoded.length <= MAX_BASIC_AUTH_DECODED_LENGTH ? decoded.indexOf(':') : -1;
      if (separator > -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPass = decoded.slice(separator + 1);
        if (safeEqual(givenUser, user) && safeEqual(givenPass, pass)) return authenticatedAdminResponse();
      }
    } catch {}
  }

  // Count only failed authentication. Normal admin page loads and mutations
  // are not throttled, while repeated guesses from one trusted proxy identity
  // receive a finite retry boundary. Missing/malformed identities deliberately
  // share one conservative bucket.
  // Evaluate the aggregate counter for every failed credential, including a
  // source already over its individual ceiling. Short-circuiting on the
  // client result would let one noisy address hide the true process-wide
  // failure rate, then leave a rotating attacker a fresh global allowance.
  const clientLimited = failedAdminAuthLimited(req);
  const globallyLimited = failedAdminAuthGloballyLimited();
  if (clientLimited || globallyLimited) {
    return new NextResponse('Too many authentication attempts. Try again later.', {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.ceil(ADMIN_AUTH_FAILURE_WINDOW_MS / 1000)),
      },
    });
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="QY Roam Admin"', 'Cache-Control': 'no-store' }
  });
}

export const config = { matcher: ['/admin/:path*', '/api/admin/:path*', '/success', '/booking'] };
