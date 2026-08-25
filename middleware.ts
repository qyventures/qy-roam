import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith('/admin')) return NextResponse.next();

  const user = process.env.ADMIN_BASIC_USER;
  const pass = process.env.ADMIN_BASIC_PASSWORD;
  if (!user || !pass) return new NextResponse('Admin access is not configured.', { status: 503 });

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const [givenUser, givenPass] = atob(auth.slice(6)).split(':');
      if (givenUser === user && givenPass === pass) return NextResponse.next();
    } catch {}
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="QY Roam Admin"' }
  });
}

export const config = { matcher: ['/admin/:path*'] };
