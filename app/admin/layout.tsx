import Link from 'next/link';

const items = [
  ['Sales Orders','/admin'],
  ['New Order','/admin/manual-order'],
  ['Inventory','/admin/inventory'],
  ['CRM','/admin/crm'],
  ['Reports','/admin/reports'],
  ['Forecasting','/admin/forecasting'],
  ['Closing','/admin/closing'],
  ['Launch','/admin/launch'],
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>
    <div style={{borderBottom:'1px solid #e5e7eb',background:'#fff',position:'sticky',top:0,zIndex:20}}>
      <div className="wrap" style={{display:'flex',gap:10,overflowX:'auto',padding:'12px 0'}}>
        {items.map(([label,href]) => <Link key={href} href={href} className="secondary" style={{whiteSpace:'nowrap'}}>{label}</Link>)}
      </div>
    </div>
    {children}
  </>;
}
