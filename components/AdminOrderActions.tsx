'use client';

import { useState } from 'react';
import { allowedFulfilmentStatuses } from '@/lib/orderLifecycle';

export default function AdminOrderActions({ id, initialStatus, productType = 'pocket_wifi', courierTracking = '', returnTracking = '' }: { id: number; initialStatus: string; productType?: string | null; courierTracking?: string | null; returnTracking?: string | null }) {
  const isEsim = productType === 'esim';
  const [currentStatus, setCurrentStatus] = useState(initialStatus);
  const [status, setStatus] = useState(initialStatus);
  const statuses = allowedFulfilmentStatuses(productType, currentStatus);
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
      const result = await res.json().catch(() => null) as { fulfilment_status?: string; error?: string } | null;
      if (!res.ok) throw new Error(result?.error || 'Update failed');
      if (!result?.fulfilment_status) throw new Error('Invalid update response');
      setCurrentStatus(result.fulfilment_status);
      setStatus(result.fulfilment_status);
      setMessage('Saved');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save'); }
    finally { setSaving(false); }
  }

  return <div style={{display:'grid',gap:6,minWidth:190}}>
    <select aria-label="Fulfilment status" value={status} onChange={e=>setStatus(e.target.value)} disabled={statuses.length < 2}>{statuses.map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select>
    {!isEsim && <>
      <input aria-label="Courier tracking" placeholder="Courier tracking" value={courier} onChange={e=>setCourier(e.target.value)} />
      <input aria-label="Return tracking" placeholder="Return tracking" value={returned} onChange={e=>setReturned(e.target.value)} />
    </>}
    {isEsim && <small>Mark fulfilled after the QR code / activation instructions have been sent to the customer.</small>}
    <button type="button" onClick={save} disabled={saving || statuses.length < 2}>{saving ? 'Saving…' : 'Save'}</button>
    {message && <small aria-live="polite">{message}</small>}
  </div>;
}
