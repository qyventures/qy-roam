# QY Roam launch marketing plan

Updated: 29 Aug 2026 (SGT)

## Launch guardrails
- Brand: QY Roam / QY Venture Pte. Ltd.
- Support WhatsApp: +65 8032 7183
- Paid Meta spend: DO NOT activate without explicit approval; hard launch ceiling S$10/day.
- Pocket WiFi promo: QY10 = 10% off rental component through 30 Sep 2026; courier excluded.
- eSIM pricing: server-authoritative; only publish/expand plans where current Changi Recommends comparable benchmark has been verified; launch target 15% below comparable public price.
- eSIM orders must remain product_type=esim and must never decrement Pocket WiFi inventory.

## Meta campaign draft A — Pocket WiFi
Objective: Sales / website purchases.
Primary text: Travelling soon? Keep your group connected with one Pocket WiFi. QY Roam delivers in Singapore before your trip, with simple return tracking after you’re home. Use QY10 for 10% off the rental component through 30 Sep 2026.
Headline: Pocket WiFi from QY Roam
Description: Share across devices. Singapore delivery. QY10 launch offer.
CTA: Book Now
Landing page: https://qyroam.com/#plans
Creative concept: clean airport/travel scene with a single pocket router, 2–4 phones connected, large “QY10 · 10% OFF RENTAL” and “Delivered before you fly”. No competitor logos.

## Meta campaign draft B — Travel eSIM
Objective: Sales / website purchases.
Primary text: Skip the router when you only need data on one phone. Choose a QY Roam travel eSIM, pay online and receive digital fulfilment support for your trip.
Headline: Travel eSIM, ready for your trip
Description: Digital travel data. No device return.
CTA: Shop Now
Landing page: https://qyroam.com/esim
Creative concept: phone showing an eSIM setup screen beside boarding-pass/travel cues; “No device collection · No return”. Do not advertise a price advantage unless the displayed plan has a current verified comparable benchmark.

## Google Search draft
Campaign 1: Pocket WiFi Singapore
Keywords: [pocket wifi singapore], [travel wifi singapore], [portable wifi rental singapore], “pocket wifi rental”, “wifi router travel”.
Headlines: Pocket WiFi For Your Trip | QY Roam Singapore | Share WiFi Across Devices | Delivered Before You Fly | QY10: 10% Off Rental
Descriptions: Book Pocket WiFi for your travel dates. Singapore delivery and tracked return flow. / Keep multiple devices connected overseas with one travel router. QY10 launch offer applies to rental through 30 Sep 2026.

Campaign 2: Travel eSIM Singapore
Keywords: [travel esim singapore], [esim for travel], [overseas esim singapore], “travel esim”, “international esim”.
Headlines: QY Roam Travel eSIM | eSIM For Your Next Trip | No Router To Return | Buy Travel Data Online
Descriptions: Choose a travel eSIM for your destination and complete checkout online. / Digital travel connectivity with QY Roam support on WhatsApp +65 8032 7183.

## Measurement
- Meta browser events only after advertising consent.
- InitiateCheckout: product_type, content/plan identifier, SGD value, item count.
- Purchase: server-side after verified Stripe payment; use event_id for deduplication if browser Purchase is added.
- Do not send raw sensitive PII to browser analytics.
- UTM convention: utm_source=meta|google, utm_medium=paid_social|cpc, utm_campaign=qyroam_launch_2026, utm_content=<creative>.

## Current external benchmark notes
Changi Recommends currently describes Travel eSIM as QR-code based, single-device activation; validity begins upon installation/activation and QR codes are single-use. Its Pocket WiFi FAQ uses full rental-day charging and late-return charging. Yoowifi currently positions both Pocket WiFi and eSIM as travel connectivity products. These are functional references only; QY Roam branding, copy and design must remain original.

## Paid-launch gate
Do not activate paid campaigns until production has: (1) Stripe webhook signing secret configured and a controlled successful live payment has persisted an order end-to-end; (2) Meta Pixel ID configured; (3) Meta CAPI token configured if server Purchase reporting is to be used; (4) campaign/ad account approval for real spend.
