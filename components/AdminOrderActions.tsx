'use client';

import { useState } from 'react';

const wifiStatuses = ['paid','packing','dispatched','with_customer','return_due','returned','closed','cancelled'];
const esimStatuses = ['awaiting_fulfilment','fulfilled','closed','cancelled'];

export default function AdminOrderActions({ id, initialStatus, productType = 'pocket_wifi', courierTracking = '', returnTracking = '' }: { id: number; initialStatus: string; productType?: string | null; courierTracking?: string | null; returnTracking?: string | null }) {
  const isEsim = productType === 'esim';
  const statuses = isEsim ? esimStatuses : wifiStatuses;
  const [status, setStatus] = useState(initialStatus);
  const [courier, setCourier] = useState(courierTracking || '');
  const [returned, setReturned] = useState(returnTracking || '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function save() {
    setSaving(true); setMessage('');
    try {
      const body: Record<string, string> = { status };
      if (!isEsim) {
        body.courier_tracking = courier;
        body.return_tracking = returned;
      }
      const res = await fetch(`/api/admin/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('Update failed');
      setMessage('Saved');
    } catch { setMessage('Could not save'); }
    finally { setSaving(false); }
  }

  return <div style={{display:'grid',gap:6,minWidth:190}}>
    <select aria-label="Fulfilment status" value={status} onChange={e=>setStatus(e.target.value)}>{statuses.map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select>
    {!isEsim && <>
      <input aria-label="Courier tracking" placeholder="Courier tracking" value={courier} onChange={e=>setCourier(e.target.value)} />
      <input aria-label="Return tracking" placeholder="Return tracking" value={returned} onChange={e=>setReturned(e.target.value)} />
    </>}
    {isEsim && <small>Mark fulfilled after the QR code / activation instructions have been sent to the customer.</small>}
    <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    {message && <small aria-live="polite">{message}</small>}
  </div>;
}
