import type { Metadata } from 'next';
import Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Booking status | QY Roam',
  robots: { index: false, follow: false },
};

type Props = {
  searchParams?: { session_id?: string };
};

const statusLabels: Record<string, string> = {
  awaiting_payment: 'Awaiting payment confirmation',
  payment_failed: 'Payment failed',
  paid: 'Paid — preparing your order',
  packing: 'Packing your pocket WiFi',
  dispatched: 'Dispatched for delivery',
  'with customer': 'Delivered / with customer',
  return_due: 'Return due',
  returned: 'Returned to QY Roam',
  closed: 'Rental completed',
  cancelled: 'Cancelled',
};

export default async function BookingPage({ searchParams }: Props) {
  const sessionId = searchParams?.session_id?.trim();
  const key = process.env.STRIPE_SECRET_KEY;

  if (!sessionId || !sessionId.startsWith('cs_') || !key) {
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Booking status</span>
        <h1>Open your booking from the confirmation link.</h1>
        <p>This page needs the secure booking reference from your QY Roam checkout confirmation.</p>
        <p>If you need help, contact <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }

  try {
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const supabase = getSupabaseAdmin();
    const order = supabase
      ? await supabase
          .from('orders')
          .select('fulfilment_status,courier_tracking,return_tracking,dispatched_at,returned_at')
          .eq('stripe_session_id', sessionId)
          .maybeSingle()
      : null;

    const fulfilment = order?.data?.fulfilment_status || (session.payment_status === 'paid' ? 'paid' : 'awaiting_payment');
    const destination = session.metadata?.country || 'your destination';
    const start = session.metadata?.start || '';
    const end = session.metadata?.end || '';
    const amount = session.amount_total != null ? `S$${(session.amount_total / 100).toFixed(2)}` : '';
    const paid = session.payment_status === 'paid';

    return (
      <main className="wrap section legal">
        <span className="eyebrow">Booking status</span>
        <h1>{paid ? statusLabels[fulfilment] || 'Booking confirmed' : 'Payment not yet confirmed'}</h1>
        <p><strong>{destination}</strong>{start && end ? ` · ${start} to ${end}` : ''}{amount ? ` · ${amount}` : ''}</p>

        {paid ? (
          <>
            <p>Your payment is confirmed. We’ll use the Singapore delivery details from checkout to fulfil your order.</p>
            {order?.data?.courier_tracking && <p><strong>Delivery tracking:</strong> {order.data.courier_tracking}</p>}
            {order?.data?.return_tracking && <p><strong>Return tracking:</strong> {order.data.return_tracking}</p>}
            {fulfilment === 'return_due' && <p>Please hand the complete device kit to the return courier within 5 calendar days after your rental ends and keep the tracking receipt until QY Roam confirms receipt.</p>}
          </>
        ) : (
          <p>If you just completed PayNow or another payment method, allow a short time for Stripe to confirm it, then refresh this page.</p>
        )}

        <p>Need to change delivery details or need urgent help? Call <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a>.</p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  } catch (error) {
    console.error('booking_status_lookup_error', error);
    return (
      <main className="wrap section legal">
        <span className="eyebrow">Booking status</span>
        <h1>We couldn’t load this booking.</h1>
        <p>Please check the original confirmation link or contact <a href="tel:+6580327183"><strong>+65 8032 7183</strong></a> for help.</p>
        <a className="secondary" href="/">Back to QY Roam</a>
      </main>
    );
  }
}
