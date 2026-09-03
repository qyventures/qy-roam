import { createStripeClient } from '@/lib/stripeClient';
import { validateQyRoamSession, type QyRoamProductType } from '@/lib/qyRoamSession';
import MetaPurchase from '@/components/MetaPurchase';
import { validStripeCheckoutSessionId } from '@/lib/stripeSessionId';

export const dynamic = 'force-dynamic';

type Props = {
  searchParams?: { session_id?: string | string[] };
};

export default async function SuccessPage({ searchParams }: Props) {
  const sessionId = validStripeCheckoutSessionId(searchParams?.session_id);
  const key = process.env.STRIPE_SECRET_KEY;

  let paid = false;
  let destination = '';
  let start = '';
  let end = '';
  let amount = '';
  let productType: QyRoamProductType | null = null;
  let planName = '';
  let planId = '';
  let measurementConsent = false;

  if (sessionId && key) {
    try {
      const stripe = createStripeClient(key);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const validation = validateQyRoamSession(session);
      if (!validation.valid) throw new Error(`Invalid QY Roam Checkout Session: ${validation.reason}`);
      productType = validation.productType;
      paid = session.payment_status === 'paid';
      destination = session.metadata?.country || '';
      start = session.metadata?.start || '';
      end = session.metadata?.end || '';
      planName = session.metadata?.plan_name || '';
      planId = session.metadata?.plan_id || '';
      measurementConsent = session.metadata?.measurement_consent === 'accepted';
      amount = session.amount_total != null ? `S$${(session.amount_total / 100).toFixed(2)}` : '';
    } catch (error) {
      console.error('success_session_lookup_error', error);
    }
  }

  if (!productType) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Order status</span>
        <h1>We couldn’t load this QY Roam order.</h1>
        <p>Please use the confirmation link from your QY Roam checkout or contact us for help.</p>
        <p><a href="tel:+6580327183"><strong>+65 8032 7183</strong></a></p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }

  if (!paid) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Payment status</span>
        <h1>We’re still confirming your payment.</h1>
        <p>If you completed payment, please wait a moment and refresh this page. Some payment methods can take a little longer to confirm.</p>
        {sessionId && <p><a className="secondary" href={`/booking?session_id=${encodeURIComponent(sessionId)}`}>Check booking status</a></p>}
        <p>If you need help, contact us at <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }

  const isEsim = productType === 'esim';
  const contentId = isEsim ? `esim:${planId}` : `pocket_wifi:${destination}`;
  const purchaseValue = amount ? Number(amount.slice(2)) : Number.NaN;
  return (
    <main className="wrap section legal">
      {sessionId && <MetaPurchase sessionId={sessionId} measurementConsent={measurementConsent} productType={productType} contentId={contentId} value={purchaseValue} />}
      <span className="eyebrow">Order confirmed</span>
      <h1>Thank you — your QY Roam order is confirmed.</h1>
      {(destination || planName) && <p><strong>{planName || destination}</strong>{start && end ? ` · ${start} to ${end}` : ''}{amount ? ` · ${amount}` : ''}</p>}
      {isEsim ? (
        <>
          <p>Your payment is confirmed. We’ll process your eSIM fulfilment using the email address from checkout.</p>
          <p>Please make sure your device supports eSIM before installation. If you need help with setup, contact our Singapore support team.</p>
        </>
      ) : (
        <>
          <p>We’ll use the contact and Singapore delivery details from your checkout to arrange your pocket WiFi delivery before your trip.</p>
          <p>Please keep the device, cable and pouch together during your rental. Return instructions will be supplied with the order.</p>
        </>
      )}
      {sessionId && <p><a className="secondary" href={`/booking?session_id=${encodeURIComponent(sessionId)}`}>View order status</a></p>}
      <p>If you need help, contact us at <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
      <a className="secondary" href={isEsim ? '/esim' : '/'}>{isEsim ? 'Back to eSIM plans' : 'Back to QY Roam'}</a>
    </main>
  );
}
