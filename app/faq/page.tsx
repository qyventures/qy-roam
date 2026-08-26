export const metadata = { title: 'FAQ | QY Roam', description: 'Frequently asked questions about QY Roam pocket WiFi rental, delivery, use and returns.' };

const faqs = [
  ['How does QY Roam work?', 'Choose your destination and travel dates, reserve your pocket WiFi online, and we will courier it to your Singapore delivery address before departure. After your trip, follow the return instructions supplied with your order.'],
  ['How early should I book?', 'Please book at least 2 days before your travel start date for normal courier fulfilment. For urgent travel, contact us on WhatsApp at +65 8032 7183 before paying.'],
  ['Can I connect more than one device?', 'Yes. Pocket WiFi is designed to share one connection across multiple phones, tablets or laptops. Actual performance depends on the local mobile network and simultaneous usage.'],
  ['When does my rental period start?', 'Your booked usage period runs from the start date through the end date shown in your reservation, inclusive.'],
  ['How do I return the device?', 'Pack the complete equipment set after your trip and follow the return courier instructions supplied with your order. Hand it to the return courier within 5 calendar days after your rental ends and keep your tracking or acceptance evidence until receipt is confirmed.'],
  ['What if the device is lost or damaged?', 'Contact us promptly. Any applicable loss or damage charge is handled under the rental terms; we will contact you before applying a charge.'],
  ['What payment methods can I use?', 'Checkout is processed securely by Stripe. Card and PayNow availability is shown at checkout.'],
  ['Is coverage guaranteed everywhere?', 'Coverage, speed and network availability depend on local mobile operators, geography, congestion and device conditions.'],
  ['How can I get help?', 'WhatsApp or call our Singapore support team at +65 8032 7183.']
];

export default function FAQ() {
  return <main className="wrap section"><span className="eyebrow">Help centre</span><h1>Frequently asked questions</h1><p className="lead">Everything you need to know before travelling with QY Roam.</p><div className="faq-list">{faqs.map(([q,a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div><section className="cta"><h2>Still need help?</h2><p>Our Singapore support team can help with bookings, delivery and returns.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section></main>;
}
