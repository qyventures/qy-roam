// Canonical Stripe endpoint. Keep /api/stripe-webhook available as a legacy
// alias so an existing Stripe configuration can be migrated without downtime.
export const runtime = 'nodejs';
export { POST } from '../../stripe-webhook/route';
