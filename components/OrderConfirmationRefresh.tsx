'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const REFRESH_INTERVAL_MS = 3_000;
const MAX_REFRESH_ATTEMPTS = 20;

/**
 * A Stripe redirect can beat the signed webhook by a few seconds. Refresh the
 * server-rendered confirmation while it is pending, without weakening the
 * page's durable-order checks or asking the traveller to resubmit checkout.
 */
export default function OrderConfirmationRefresh() {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (attempts >= MAX_REFRESH_ATTEMPTS) return;
    const timer = window.setTimeout(() => {
      // Do not spend the bounded retry window while the tab is backgrounded.
      // A visibility change below resumes confirmation promptly.
      if (document.visibilityState !== 'visible') return;
      setAttempts((current) => current + 1);
      router.refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [attempts, router]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible' && attempts < MAX_REFRESH_ATTEMPTS) {
        setAttempts((current) => current + 1);
        router.refresh();
      }
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [attempts, router]);

  return (
    <p className="muted" role="status" aria-live="polite">
      {attempts < MAX_REFRESH_ATTEMPTS
        ? 'This page is checking the secure order record automatically.'
        : 'Automatic checking has paused. Refresh this page or contact support if the order is still pending.'}
    </p>
  );
}
