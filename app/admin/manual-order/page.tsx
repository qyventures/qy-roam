import ManualOrderForm from '@/components/ManualOrderForm';
export const dynamic='force-dynamic';
export default function ManualOrderPage(){return <main className="wrap section legal" style={{maxWidth:1100}}><span className="eyebrow">Sales Orders</span><h1>New manual order</h1><ManualOrderForm/></main>}
