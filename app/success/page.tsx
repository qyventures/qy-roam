import { createStripeClient } from '@/lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validateQyRoamSession, type QyRoamProductType } from '@/lib/qyRoamSession';
import MetaPurchase from '@/components/MetaPurchase';
import { validStripeCheckoutSessionId } from '@/lib/stripeSessionId';
import { hasRequiredStripeCheckoutConfig } from '@/lib/productionReadiness';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';

export const dynamic = 'force-dynamic';
export const metadata = {
  robots: { index: false, follow: false },
};

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
  let checkoutExpired = false;
  let measurementConsent = false;
  let orderPersisted = false;
  let orderLookupFailed = false;

  // Keep the confirmation page on the same Stripe credential boundary as
  // checkout and webhook processing. In production, a mistakenly deployed
  // test key must not be able to render a test-mode session as a customer
  // payment confirmation while the real order pipeline is unavailable.
  if (sessionId && key && hasRequiredStripeCheckoutConfig()) {
    try {
      const stripe = createStripeClient(key);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // Stripe credentials normally scope reads to one mode, but make the
      // trust boundary explicit here as it is in the webhook. A misrouted
      // client or an unexpected Stripe response must never turn a session
      // from the other mode into a customer payment confirmation.
      if (!stripeEventMatchesConfiguredMode(key, session.livemode)) {
        throw new Error('Stripe Checkout Session mode does not match configured credential');
      }
      const validation = validateQyRoamSession(session);
      if (!validation.valid) throw new Error(`Invalid QY Roam Checkout Session: ${validation.reason}`);
      productType = validation.productType;
      checkoutExpired = session.status === 'expired';
      // Keep the customer-visible payment boundary as strict as webhook
      // persistence. A paid flag on an unexpected non-complete Session must
      // not become a fulfilment-looking confirmation page before Stripe has
      // completed the Checkout lifecycle.
      paid = session.status === 'complete' && session.payment_status === 'paid';
      destination = session.metadata?.country || '';
      start = session.metadata?.start || '';
      end = session.metadata?.end || '';
      planName = session.metadata?.plan_name || '';
      planId = session.metadata?.plan_id || '';
      measurementConsent = session.metadata?.measurement_consent === 'accepted';
      amount = session.amount_total != null ? `S$${(session.amount_total / 100).toFixed(2)}` : '';

      // Stripe remains the authority for payment, but do not imply that
      // fulfilment has already received the order while its durable ledger is
      // unavailable or the signed webhook is still being processed. This is
      // especially important when a shopper reloads the success URL after a
      // network interruption: placing a second order would be the wrong
      // recovery action for a payment that Stripe has already accepted.
      if (paid) {
        const supabase = getSupabaseAdmin();
        if (!supabase) {
          orderLookupFailed = true;
        } else {
          const orderResult = await supabase
            .from('orders')
            .select('payment_status')
            .eq('stripe_session_id', session.id)
            .maybeSingle();
          // A previously received asynchronous-completion event can have
          // created an awaiting-payment row. The success page must wait for
          // the paid snapshot, not merely any row for this Checkout Session.
          orderPersisted = orderResult.data?.payment_status === 'paid';
          orderLookupFailed = Boolean(orderResult.error);
        }
      }
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
        <h1>{checkoutExpired ? 'This secure checkout session has expired.' : 'We’re still confirming your payment.'}</h1>
        {checkoutExpired ? (
          <p>No payment was completed for this session. Please return to the plans page to start a new secure checkout.</p>
        ) : (
          <p>If you completed payment, please wait a moment and refresh this page. Some payment methods can take a little longer to confirm.</p>
        )}
        {sessionId && !checkoutExpired && <p><a className="secondary" href={`/booking?session_id=${encodeURIComponent(sessionId)}`}>Check booking status</a></p>}
        <p>If you need help, contact us at <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
        <a className="secondary" href={productType === 'esim' ? '/esim' : '/'}>{checkoutExpired ? 'Choose a plan' : 'Back to QY Roam'}</a>
      </main>
    );
  }

  const isEsim = productType === 'esim';
  const contentId = isEsim ? `esim:${planId}` : `pocket_wifi:${destination}`;
  const purchaseValue = amount ? Number(amount.slice(2)) : Number.NaN;
  return (
    <main className="wrap section legal">
      {sessionId && <MetaPurchase sessionId={sessionId} measurementConsent={measurementConsent} productType={productType} contentId={contentId} value={purchaseValue} />}
      <span className="eyebrow">{orderPersisted ? 'Order confirmed' : 'Payment confirmed'}</span>
      <h1>{orderPersisted ? 'Thank you — your QY Roam order is confirmed.' : 'Thank you — your payment is confirmed.'}</h1>
      {(destination || planName) && <p><strong>{planName || destination}</strong>{start && end ? ` · ${start} to ${end}` : ''}{amount ? ` · ${amount}` : ''}</p>}
      {isEsim ? (
        <>
          {orderPersisted ? (
            <p>Your payment is confirmed. We’ll process your eSIM fulfilment using the email address from checkout.</p>
          ) : (
            <p>Your payment is confirmed, and we’re {orderLookupFailed ? 'temporarily unable to verify' : 'finalising'} the order record for eSIM fulfilment. Please do not place a second order; refresh this page in a moment or contact our support team if you need help.</p>
          )}
          <p>Please make sure your device supports eSIM before installation. If you need help with setup, contact our Singapore support team.</p>
        </>
      ) : (
        <>
          {orderPersisted ? (
            <p>We’ll use the contact and Singapore delivery details from your checkout to arrange your pocket WiFi delivery before your trip.</p>
          ) : (
            <p>Your payment is confirmed, and we’re {orderLookupFailed ? 'temporarily unable to verify' : 'finalising'} the order record before arranging Pocket WiFi delivery. Please do not place a second order; refresh this page in a moment or contact our support team if you need help.</p>
          )}
          <p>Please keep the device, cable and pouch together during your rental. Return instructions will be supplied with the order.</p>
        </>
      )}
      {sessionId && <p><a className="secondary" href={`/booking?session_id=${encodeURIComponent(sessionId)}`}>View order status</a></p>}
      <p>If you need help, contact us at <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
      <a className="secondary" href={isEsim ? '/esim' : '/'}>{isEsim ? 'Back to eSIM plans' : 'Back to QY Roam'}</a>
    </main>
  );
}
