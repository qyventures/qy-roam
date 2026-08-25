import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/admin') && !req.nextUrl.pathname.startsWith('/api/admin')) {
    return NextResponse.next();
  }

  const user = process.env.ADMIN_BASIC_USER;
  const pass = process.env.ADMIN_BASIC_PASSWORD;
  if (!user || !pass) return new NextResponse('Admin access is not configured.', { status: 503 });

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
