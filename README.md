# QY Roam

Sales-ready Pocket Wi-Fi rental MVP for QY Venture Pte. Ltd.

## Production shape

- Next.js storefront and admin app on the QY VPS
- Stripe Checkout for card and PayNow-compatible payment flows
- Supabase order storage and inventory-aware availability
- Nginx TLS reverse proxy for `qyroam.com`
- systemd service for restart-on-failure and boot persistence
- Meta Pixel/CAPI instrumentation gated by advertising consent
- Dedicated local app port `3100` to avoid conflicts with other Next.js services on the VPS

The canonical Stripe webhook endpoint is `https://qyroam.com/api/stripe/webhook`.
The legacy `/api/stripe-webhook` endpoint remains available during migration;
configure only the canonical endpoint in Stripe to avoid duplicate deliveries.

## VPS deployment

The repo is expected at `/root/qy-roam` and production secrets at `/root/.config/qyroam/.env` with mode `600`.

Install the service once:

```bash
cp /root/qy-roam/deploy/qy-roam.service /etc/systemd/system/qy-roam.service
systemctl daemon-reload
systemctl enable qy-roam
```

Deploy/redeploy without GitHub Actions:

```bash
cd /root/qy-roam
bash deploy/deploy.sh
```

The script fast-forwards `main`, installs dependencies, validates public pricing, builds with the protected env file, restarts the service, then uses `HEALTH_CHECK_TOKEN` to verify launch readiness at `http://127.0.0.1:3100/api/health`.

## Nginx and TLS

`deploy/nginx-qyroam.conf` is the production reverse-proxy template and proxies QY Roam to `127.0.0.1:3100`. Provision the certificate only after `qyroam.com` and `www.qyroam.com` point to the VPS. Then enable the site and test Nginx before reload.

## Required production configuration

See `.env.example`. Launch-critical values include Stripe secret/publishable keys, Stripe webhook secret, Supabase URL/service-role key, admin credentials, production site URL, inventory, and delivery lead time. Meta Pixel/CAPI values can remain unset until measurement is authorized.

For compatibility, deployments using the older `ADMIN_BASIC_USER`,
`ADMIN_BASIC_PASSWORD`, or `META_CAPI_TOKEN` names continue to work. New
deployments should use the canonical names shown in `.env.example`.

Never commit `.env` or live secrets to this public repository.
