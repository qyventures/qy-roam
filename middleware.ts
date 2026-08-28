import { NextRequest, NextResponse } from 'next/server';

const FALLBACK_ADMIN_USER = 'qyadmin';
const FALLBACK_ADMIN_PASSWORD_SHA256 = 'eb318b0fc26100575d21a29d0bf7ac979e5a8cec612a26f008ec1a67b290ce76';

function safeEqual(a: string, b: string) {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/admin') && !req.nextUrl.pathname.startsWith('/api/admin')) {
    return NextResponse.next();
  }

  const user = process.env.ADMIN_BASIC_USER || FALLBACK_ADMIN_USER;
  const pass = process.env.ADMIN_BASIC_PASSWORD;
  const passHash = process.env.ADMIN_BASIC_PASSWORD_SHA256 || FALLBACK_ADMIN_PASSWORD_SHA256;

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPass = decoded.slice(separator + 1);
        const passwordMatches = pass
          ? safeEqual(givenPass, pass)
          : safeEqual(await sha256(givenPass), passHash);
        if (safeEqual(givenUser, user) && passwordMatches) return NextResponse.next();
      }
    } catch {}
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="QY Roam Admin"', 'Cache-Control': 'no-store' }
  });
}

export const config = { matcher: ['/admin/:path*', '/api/admin/:path*'] };
