# QY Roam Production Launch Runbook

Use this checklist for the first public launch. It is deliberately ordered so DNS and advertising are not switched before payment/order persistence is healthy.

## 1. VPS production configuration

Keep all secrets only in `/root/.config/qyroam/.env` with mode `600`.

Required before launch:

- `STRIPE_SECRET_KEY` — live `sk_live_...` or restricted live `rk_live_...`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — live `pk_live_...`
- `STRIPE_WEBHOOK_SECRET` — live `whsec_...` after webhook creation
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_USER`
- `ADMIN_PASSWORD` — strong unique password
- `NEXT_PUBLIC_SITE_URL=https://qyroam.com`
- `POCKET_WIFI_INVENTORY` — actual units available for sale
- `MIN_DELIVERY_LEAD_DAYS=2` unless operations approves another value
- `HEALTH_CHECK_TOKEN` — random value of at least 24 characters used by the private deployment readiness check
- SMTP host, credentials, sender and fulfilment recipient for paid-order alerts

Optional until measurement launch:

- Meta Pixel ID
- Meta CAPI access token

Never place live credentials in GitHub.

## 2. Deploy privately on VPS

From the privileged VPS account:

```bash
cd /root/qy-roam
git pull --ff-only origin main
bash deploy/deploy.sh
```

Expected result: optimized Next.js build succeeds, `qy-roam` restarts, and the local health endpoint responds.

The production service is intentionally bound to **port 3100** on the VPS. Other local ports are used by separate applications, so use this port for QY Roam health checks.

Check manually if needed:

```bash
curl -sS http://127.0.0.1:3100/api/health
systemctl status qy-roam --no-pager
journalctl -u qy-roam -n 100 --no-pager
```

The unauthenticated endpoint above is a liveness probe and intentionally does not disclose configuration. `deploy/deploy.sh` uses `HEALTH_CHECK_TOKEN` to verify private launch readiness and fails if any launch-critical configuration is missing. Do not proceed unless that deployment check passes.

## 3. DNS and HTTPS

Point `qyroam.com` and `www.qyroam.com` to the production VPS only after the local service is healthy. Enable the supplied Nginx site, obtain the TLS certificate, test Nginx configuration, then reload Nginx.

Verify:

- `https://qyroam.com` loads without certificate warnings
- `https://qyroam.com/api/health` is reachable
- `/admin` requires authentication
- `/api` and `/admin` remain noindex/no-store

## 4. Stripe webhook

Create a live Stripe webhook endpoint at:

`https://qyroam.com/api/stripe/webhook`

Subscribe to the Checkout/payment events used by the application, copy the resulting `whsec_...` into the protected VPS env file, redeploy/restart, and confirm `/api/health` becomes ready.

## 5. End-to-end payment smoke test

Before deploying this application version, apply `supabase/schema.sql` to the production Supabase project. The checkout and webhook require the `orders`, `checkout_reservations`, `stripe_events`, `fulfilment_notifications`, and `meta_purchase_deliveries` tables plus the `qy_reserve_pocket_wifi` function; deploy the schema before restarting the app so atomic inventory reservation and paid webhook processing cannot fail on missing database objects.

Before advertising, make one controlled real booking using the lowest practical charge and verify:

1. Destination/date availability succeeds.
2. Displayed price matches Stripe Checkout.
3. Card or PayNow payment reaches a paid state.
4. Stripe webhook persists exactly one order in Supabase.
5. Customer confirmation and booking-status pages show the correct state.
6. Admin dashboard shows the order and can advance fulfilment status.
7. A repeated webhook does not create a duplicate order/event.
8. Inventory for overlapping dates decreases appropriately.

Refund/cancel the controlled transaction afterward if operationally appropriate.

## 6. Operations gate

Before accepting public orders, confirm internally:

- actual Pocket Wi-Fi fleet quantity
- outbound courier charge shown/charged to customer
- return courier/drop-off process and return address
- replacement/loss/damage/late-return fee schedule
- who monitors `+65 8032 7183`
- who owns daily packing, dispatch, return chasing and refunds

## 7. Meta measurement and ads

Only after the purchase smoke test passes:

1. Add production Pixel/CAPI credentials.
2. Verify advertising consent blocks Meta measurement until opt-in.
3. Verify PageView/ViewContent/InitiateCheckout/Purchase as applicable.
4. Confirm Purchase deduplication/event IDs.
5. Keep campaigns draft-only until explicit launch authorization.
6. Initial live spend must not exceed **S$10/day total** without approval.

Current draft allocation: S$6/day broad Singapore outbound travellers and S$4/day Japan/Korea travellers.

## 8. QY Venture corporate-site link

After `qyroam.com` is public and tested, add a QY Roam capability card/link on `qyvent.com`. Treat `qyvent.com` as the corporate/discovery site and `qyroam.com` as the transactional booking site.

## Rollback

If checkout/order persistence or HTTPS fails after cutover, stop paid traffic, restore the prior DNS/site state where possible, keep the VPS logs, and do not accept new bookings until `/api/health` and the end-to-end payment path are healthy again.
