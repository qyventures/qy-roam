import HomePageClient from '@/components/HomePageClient';
import { wifiBenchmarkIsFresh } from '@/lib/wifiPlans';

// The storefront client evaluates Singapore-clock promotion and catalogue
// eligibility during its initial render. Keep only `/` request-time rendered
// so an expired offer cannot survive in cached HTML, while legal, FAQ, and
// other public pages retain their normal static optimisation.
export const dynamic = 'force-dynamic';

export default function HomePage() {
  // Checkout and availability already fail closed when the reviewed public
  // benchmark ages out. Pass that same request-time authority into the client
  // storefront so cached JavaScript cannot keep advertising a stale quote or
  // inviting a booking that the server will correctly refuse.
  return <HomePageClient pocketWifiPricingFresh={wifiBenchmarkIsFresh()} />;
}
