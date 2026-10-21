import { createStripeClient } from '@/lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validateQyRoamSession, type QyRoamProductType } from '@/lib/qyRoamSession';
import MetaPurchase from '@/components/MetaPurchase';
import { validStripeCheckoutSessionId, validStripeCheckoutSessionIdForMode } from '@/lib/stripeSessionId';
import { hasRequiredStripeCheckoutConfig } from '@/lib/productionReadiness';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';
import OrderConfirmationRefresh from '@/components/OrderConfirmationRefresh';
import { durableOrderMatchesFailedSession, durableOrderMatchesPaidSession } from '@/lib/durableOrderSnapshot';
import { tryAcquireConfirmationConcurrency } from '@/lib/confirmationConcurrency';
import { retryableStripeConfirmationFailure } from '@/lib/confirmationLookupFailure';
import { customerOrderReference } from '@/lib/customerOrderReference';
import { metaPurchaseIdentity } from '@/lib/metaPurchaseIdentity';

export const dynamic = 'force-dynamic';
export const metadata = {
  robots: { index: false, follow: false },
};

type Props = {
  searchParams?: { session_id?: string | string[] };
};

export default async function SuccessPage({ searchParams }: Props) {
  const sessionId = validStripeCheckoutSessionId(searchParams?.session_id);
  const orderReference = customerOrderReference(sessionId);
  const key = process.env.STRIPE_SECRET_KEY?.trim();

  let paid = false;
  let destination = '';
  let start = '';
  let end = '';
  let amount = '';
  let productType: QyRoamProductType | null = null;
  let planName = '';
  let planId = '';
  let checkoutExpired = false;
  let orderPersisted = false;
  let paymentFailed = false;
  let orderLookupFailed = false;
  let confirmationBusy = false;
  let authenticatedSession = false;
  let confirmationLookupRetryable = false;

  // Keep the confirmation page on the same Stripe credential boundary as
  // checkout and webhook processing. In production, a mistakenly deployed
  // test key must not be able to render a test-mode session as a customer
  // payment confirmation while the real order pipeline is unavailable.
  if (sessionId && key && hasRequiredStripeCheckoutConfig()) {
    const releaseConfirmation = tryAcquireConfirmationConcurrency();
    if (!releaseConfirmation) confirmationBusy = true;
    try {
      if (!releaseConfirmation) throw new Error('Confirmation lookup is busy');
      const stripe = createStripeClient(key);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // The URL reference selected this exact Checkout Session. Stripe
      // credentials normally scope retrieval correctly, but an unexpected SDK
      // or upstream response must never let a different customer's session be
      // rendered as this customer's payment confirmation.
      if (validStripeCheckoutSessionIdForMode(session.id, session.livemode) !== sessionId) {
        throw new Error('Retrieved Checkout Session does not match confirmation reference');
      }
      // Stripe credentials normally scope reads to one mode, but make the
      // trust boundary explicit here as it is in the webhook. A misrouted
      // client or an unexpected Stripe response must never turn a session
      // from the other mode into a customer payment confirmation.
      if (!stripeEventMatchesConfiguredMode(key, session.livemode)) {
        throw new Error('Stripe Checkout Session mode does not match configured credential');
      }
      const validation = validateQyRoamSession(session);
      if (!validation.valid) throw new Error(`Invalid QY Roam Checkout Session: ${validation.reason}`);
      authenticatedSession = true;
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
      amount = session.amount_total != null ? `S$${(session.amount_total / 100).toFixed(2)}` : '';

      // Stripe remains the authority for payment, but do not imply that
      // fulfilment has already received the order while its durable ledger is
      // unavailable or the signed webhook is still being processed. This is
      // especially important when a shopper reloads the success URL after a
      // network interruption: placing a second order would be the wrong
      // recovery action for a payment that Stripe has already accepted.
      if (paid || (session.status === 'complete' && session.payment_status === 'unpaid')) {
        const supabase = getSupabaseAdmin();
        if (!supabase) {
          orderLookupFailed = true;
        } else {
          const orderResult = await supabase
            .from('orders')
            .select('stripe_session_id,payment_status,payment_confirmed_at,product_type,amount_sgd,plan_id,plan_name,data_allowance,country,travel_start,travel_end,measurement_consent,shipping_address,fulfilment_status')
            .eq('stripe_session_id', session.id)
            .maybeSingle();
          // A previously received asynchronous-completion event can have
          // created an awaiting-payment row. The success page must wait for
          // the paid snapshot, not merely any row for this Checkout Session.
          orderPersisted = durableOrderMatchesPaidSession(orderResult.data, session, productType);
          // An asynchronous failure is terminal only after the signed webhook
          // has written the exact failed commercial snapshot. Until then an
          // unpaid Session can still become paid, so keep polling the same
          // customer capability instead of inviting a duplicate checkout.
          paymentFailed = orderResult.data?.fulfilment_status === 'payment_failed' &&
            durableOrderMatchesFailedSession(orderResult.data, session, productType);
          orderLookupFailed = Boolean(orderResult.error);
        }
      }
    } catch (error) {
      // A customer confirmation page may call Stripe and the database. Keep
      // third-party failure text out of application logs. Expected admission
      // shedding is customer-retryable and must not create false provider
      // incidents in production logs.
      // Once the signed Session is authenticated, any later failure is safe
      // to retry against the same customer capability. Before that point,
      // retry only Stripe's explicit transient error classes: a well-formed
      // but nonexistent id must not turn one request into twenty lookups.
      confirmationLookupRetryable = authenticatedSession || retryableStripeConfirmationFailure(error);
      if (!confirmationBusy) console.error('success_session_lookup_error');
    } finally {
      releaseConfirmation?.();
    }
  }

  if (!productType) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Order status</span>
        <h1>{confirmationBusy ? 'Order confirmation is busy.' : 'We couldn’t load this QY Roam order.'}</h1>
        <p>{confirmationBusy ? 'Please wait a moment and refresh this page. Do not place a second order.' : 'Please use the confirmation link from your QY Roam checkout or contact us for help.'}</p>
        {/* Admission shedding is deliberately transient and happens before
            Stripe is queried. Rejoin the same bounded reconciliation loop as
            a paid order awaiting its durable row, so a customer returning
            from Checkout does not have to decide whether to pay again. Do
            not auto-refresh malformed or untrusted confirmation references. */}
        {(confirmationBusy || confirmationLookupRetryable) && <OrderConfirmationRefresh />}
        <p><a href="tel:+6580327183"><strong>+65 8032 7183</strong></a></p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }

  if (!paid) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Payment status</span>
        <h1>{checkoutExpired ? 'This secure checkout session has expired.' : paymentFailed ? 'This payment was unsuccessful.' : 'We’re still confirming your payment.'}</h1>
        {checkoutExpired ? (
          <p>No payment was completed for this session. Please return to the plans page to start a new secure checkout.</p>
        ) : paymentFailed ? (
          <p>No paid order was created. Please return to the plans page to start a new secure checkout, or contact us if you believe you were charged.</p>
        ) : (
          <p>If you completed payment, please wait a moment and refresh this page. Some payment methods can take a little longer to confirm.</p>
        )}
        {/* This Session has passed the complete QY Roam provenance boundary,
            so bounded automatic reconciliation cannot amplify arbitrary
            Stripe lookups. Delayed payment methods may become paid after the
            redirect page was rendered; recheck the same authenticated
            capability instead of leaving the traveller on a stale unpaid
            result or encouraging a second checkout. */}
        {!checkoutExpired && !paymentFailed && <OrderConfirmationRefresh />}
        {sessionId && !checkoutExpired && !paymentFailed && <p><a className="secondary" href={`/booking?session_id=${encodeURIComponent(sessionId)}`}>Check booking status</a></p>}
        <p>If you need help, contact us at <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
        <a className="secondary" href={productType === 'esim' ? '/esim' : '/'}>{checkoutExpired || paymentFailed ? 'Choose a plan' : 'Back to QY Roam'}</a>
      </main>
    );
  }

  const isEsim = productType === 'esim';
  const contentId = isEsim ? `esim:${planId}` : `pocket_wifi:${destination}`;
  const purchaseValue = amount ? Number(amount.slice(2)) : Number.NaN;
  const purchaseIdentity = metaPurchaseIdentity(sessionId);
  return (
    <main className="wrap section legal">
      {sessionId && purchaseIdentity && <MetaPurchase sessionId={sessionId} purchaseIdentity={purchaseIdentity} orderPersisted={orderPersisted} productType={productType} contentId={contentId} value={purchaseValue} />}
      <span className="eyebrow">{orderPersisted ? 'Order confirmed' : 'Payment confirmed'}</span>
      <h1>{orderPersisted ? 'Thank you — your QY Roam order is confirmed.' : 'Thank you — your payment is confirmed.'}</h1>
      {!orderPersisted && <OrderConfirmationRefresh />}
      {(destination || planName) && <p><strong>{planName || destination}</strong>{start && end ? ` · ${start} to ${end}` : ''}{amount ? ` · ${amount}` : ''}</p>}
      {orderReference && <p><strong>Support reference:</strong> <code>{orderReference}</code></p>}
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
