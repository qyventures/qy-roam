'use client';

import { useEffect, useState } from 'react';
import { META_CONSENT_CHANGED_EVENT, metaMeasurementAllowed, trackMetaWhenReady } from '@/lib/metaClient';

type Props = {
  sessionId: string;
  measurementConsent: boolean;
  orderPersisted: boolean;
  productType: 'esim' | 'pocket_wifi';
  contentId: string;
  value: number;
};

const PURCHASE_KEY_PREFIX = 'qyroam_meta_purchase_';

// Stripe can redirect to this page more than once and the customer can refresh
// it. CAPI deduplicates by event_id, but do not intentionally inflate browser
// Pixel reporting or repeatedly queue the same client conversion either. More
// importantly, a Stripe payment alone is not the operational order boundary:
// wait until the webhook has durably recorded the paid order, just as CAPI
// does, so reporting never counts a payment whose fulfilment record failed.
export default function MetaPurchase({ sessionId, measurementConsent, orderPersisted, productType, contentId, value }: Props) {
  const [consentRevision, setConsentRevision] = useState(0);

  useEffect(() => {
    const consentChanged = () => setConsentRevision((revision) => revision + 1);
    window.addEventListener(META_CONSENT_CHANGED_EVENT, consentChanged);
    return () => window.removeEventListener(META_CONSENT_CHANGED_EVENT, consentChanged);
  }, []);

  useEffect(() => {
    if (!orderPersisted || !measurementConsent || !metaMeasurementAllowed() || !Number.isFinite(value) || value < 0) return;
    const key = `${PURCHASE_KEY_PREFIX}${sessionId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
    } catch {
      // Storage can be unavailable in privacy-restricted browsers. The event
      // ID below still gives Meta a stable browser/CAPI deduplication key.
    }
    return trackMetaWhenReady('Purchase', {
      value: Number(value.toFixed(2)),
      currency: 'SGD',
      content_type: 'product',
      content_ids: [contentId],
      contents: [{ id: contentId, quantity: 1 }],
      content_category: productType === 'esim' ? 'Travel eSIM' : 'Pocket WiFi',
    }, { eventID: `stripe_${sessionId}` }, () => {
      try {
        window.sessionStorage.setItem(key, '1');
      } catch {
        // The stable eventID still deduplicates browser and CAPI delivery.
      }
    });
  }, [consentRevision, contentId, measurementConsent, orderPersisted, productType, sessionId, value]);

  return null;
}
