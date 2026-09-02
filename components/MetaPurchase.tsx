'use client';

import { useEffect } from 'react';
import { metaMeasurementAllowed, trackMetaWhenReady } from '@/lib/metaClient';

type Props = {
  sessionId: string;
  measurementConsent: boolean;
  productType: 'esim' | 'pocket_wifi';
  contentId: string;
  value: number;
};

const PURCHASE_KEY_PREFIX = 'qyroam_meta_purchase_';

// Stripe can redirect to this page more than once and the customer can refresh
// it. CAPI deduplicates by event_id, but do not intentionally inflate browser
// Pixel reporting or repeatedly queue the same client conversion either.
export default function MetaPurchase({ sessionId, measurementConsent, productType, contentId, value }: Props) {
  useEffect(() => {
    if (!measurementConsent || !metaMeasurementAllowed() || !Number.isFinite(value) || value < 0) return;
    const key = `${PURCHASE_KEY_PREFIX}${sessionId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Storage can be unavailable in privacy-restricted browsers. The event
      // ID below still gives Meta a stable browser/CAPI deduplication key.
    }
    trackMetaWhenReady('Purchase', {
      value: Number(value.toFixed(2)),
      currency: 'SGD',
      content_type: 'product',
      content_ids: [contentId],
      contents: [{ id: contentId, quantity: 1 }],
      content_category: productType === 'esim' ? 'Travel eSIM' : 'Pocket WiFi',
    }, { eventID: `stripe_${sessionId}` });
  }, [contentId, measurementConsent, productType, sessionId, value]);

  return null;
}
