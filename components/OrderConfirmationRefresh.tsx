'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  CONFIRMATION_REFRESH_MAX_ATTEMPTS,
  confirmationRefreshDelayMs,
} from '@/lib/confirmationRefresh';

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
    if (attempts >= CONFIRMATION_REFRESH_MAX_ATTEMPTS) return;
    // One effect owns the timer and wake-up listeners. A visibility/online
    // event can otherwise race the interval and spend two attempts on the
    // same render. The ref is advanced synchronously before router.refresh(),
    // making the retry budget authoritative even before React rerenders.
    let timer: number | undefined;
    let refreshStarted = false;
    const refreshWhenReachable = () => {
      if (
        refreshStarted ||
        attemptsRef.current >= CONFIRMATION_REFRESH_MAX_ATTEMPTS ||
        document.visibilityState !== 'visible' ||
        !navigator.onLine
      ) return;
      refreshStarted = true;
      if (timer !== undefined) window.clearTimeout(timer);
      attemptsRef.current += 1;
      setAttempts(attemptsRef.current);
      router.refresh();
    };
    // Back off after the first few checks. A fixed three-second schedule
    // spent all twenty attempts inside the middleware's one-minute overload
    // window, so a paid traveller could stop reconciling just as capacity
    // returned. This bounded schedule remains responsive while spanning more
    // than a complete throttle window.
    timer = window.setTimeout(refreshWhenReachable, confirmationRefreshDelayMs(attemptsRef.current));
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
      {attempts < CONFIRMATION_REFRESH_MAX_ATTEMPTS
        ? 'This page is checking the secure order record automatically.'
        : 'Automatic checking has paused. Refresh this page or contact support if the order is still pending.'}
    </p>
  );
}
