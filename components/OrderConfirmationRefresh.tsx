'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

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
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (attempts >= MAX_REFRESH_ATTEMPTS) return;
    // One effect owns the timer and wake-up listeners. A visibility/online
    // event can otherwise race the interval and spend two attempts on the
    // same render. The ref is advanced synchronously before router.refresh(),
    // making the retry budget authoritative even before React rerenders.
    let timer: number | undefined;
    let refreshStarted = false;
    const refreshWhenReachable = () => {
      if (
        refreshStarted ||
        attemptsRef.current >= MAX_REFRESH_ATTEMPTS ||
        document.visibilityState !== 'visible' ||
        !navigator.onLine
      ) return;
      refreshStarted = true;
      if (timer !== undefined) window.clearTimeout(timer);
      attemptsRef.current += 1;
      setAttempts(attemptsRef.current);
      router.refresh();
    };
    timer = window.setTimeout(refreshWhenReachable, REFRESH_INTERVAL_MS);
    // Do not consume the finite reconciliation budget while the tab is
    // backgrounded or the device is offline. Resume immediately when the
    // customer can actually reach the server again instead of leaving a paid
    // order stuck on a stale confirmation until a manual reload.
    document.addEventListener('visibilitychange', refreshWhenReachable);
    window.addEventListener('online', refreshWhenReachable);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenReachable);
      window.removeEventListener('online', refreshWhenReachable);
    };
  }, [attempts, router]);

  return (
    <p className="muted" role="status" aria-live="polite">
      {attempts < MAX_REFRESH_ATTEMPTS
        ? 'This page is checking the secure order record automatically.'
        : 'Automatic checking has paused. Refresh this page or contact support if the order is still pending.'}
    </p>
  );
}
