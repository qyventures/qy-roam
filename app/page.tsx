import HomePageClient from '@/components/HomePageClient';

// The storefront client evaluates Singapore-clock promotion and catalogue
// eligibility during its initial render. Keep only `/` request-time rendered
// so an expired offer cannot survive in cached HTML, while legal, FAQ, and
// other public pages retain their normal static optimisation.
export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <HomePageClient />;
}
