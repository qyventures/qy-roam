import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

type Props = {
  searchParams?: { session_id?: string };
};

export default async function SuccessPage({ searchParams }: Props) {
  const sessionId = searchParams?.session_id;
  const key = process.env.STRIPE_SECRET_KEY;

  let paid = false;
  let destination = '';
  let start = '';
  let end = '';
  let amount = '';

  if (sessionId && key && sessionId.startsWith('cs_')) {
    try {
      const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      paid = session.payment_status === 'paid';
      destination = session.metadata?.country || '';
      start = session.metadata?.start || '';
      end = session.metadata?.end || '';
      amount = session.amount_total != null ? `S$${(session.amount_total / 100).toFixed(2)}` : '';
    } catch (error) {
      console.error('success_session_lookup_error', error);
    }
  }

  if (!paid) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Payment status</span>
        <h1>We’re still confirming your payment.</h1>
        <p>
          If you completed payment, please wait a moment and refresh this page. Some payment methods can take a little longer to confirm.
        </p>
        <p>
          If you need help, contact us at{' '}
          <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.
        </p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }

  return (
    <main className="wrap section legal">
      <span className="eyebrow">Booking confirmed</span>
      <h1>Thank you — your QY Roam booking is confirmed.</h1>
      {destination && (
        <p>
          <strong>{destination}</strong>{start && end ? ` · ${start} to ${end}` : ''}{amount ? ` · ${amount}` : ''}
        </p>
      )}
      <p>
        We’ll use the contact and Singapore delivery details from your checkout to arrange your pocket WiFi delivery before your trip.
      </p>
      <p>
        Please keep the device, cable and pouch together during your rental. Return instructions will be supplied with the order.
      </p>
      <p>
        If your departure is soon or you need to change delivery details, contact us at{' '}
        <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.
      </p>
      <a className="secondary" href="/">Back to QY Roam</a>
    </main>
  );
}
