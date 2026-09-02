'use client';

import { useState } from 'react';
import { allowedFulfilmentStatuses } from '@/lib/orderLifecycle';

export default function AdminOrderActions({ id, initialStatus, productType = 'pocket_wifi', courierTracking = '', returnTracking = '', inventoryItemId = null, inventoryItems = [] }: { id: number; initialStatus: string; productType?: string | null; courierTracking?: string | null; returnTracking?: string | null; inventoryItemId?: number | null; inventoryItems?: { id: number; name: string; sku: string; quantity_on_hand: number }[] }) {
  const isEsim = productType === 'esim';
  const [currentStatus, setCurrentStatus] = useState(initialStatus);
  const [status, setStatus] = useState(initialStatus);
  const statuses = allowedFulfilmentStatuses(productType, currentStatus);
  const [courier, setCourier] = useState(courierTracking || '');
  const [returned, setReturned] = useState(returnTracking || '');
  const [inventoryItem, setInventoryItem] = useState(inventoryItemId ? String(inventoryItemId) : '');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState('');

  async function save() {
    setSaving(true); setMessage('');
    try {
      if (!isEsim && status === 'dispatched' && !courier.trim()) {
        throw new Error('Enter a courier tracking or delivery reference before dispatching.');
      }
      if (!isEsim && status === 'dispatched' && !inventoryItem) {
        throw new Error('Select the Pocket WiFi inventory item being dispatched.');
      }
      if (!isEsim && status === 'returned' && !returned.trim()) {
        throw new Error('Enter a return tracking or receipt reference before marking this order returned.');
      }
      const body: Record<string, string> = { status };
      if (!isEsim) {
        body.courier_tracking = courier;
        body.return_tracking = returned;
        if (inventoryItem) body.inventory_item_id = inventoryItem;
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

  async function retryNotifications() {
    setRetrying(true); setMessage('');
    try {
      const res = await fetch(`/api/admin/orders/${id}`, { method: 'POST' });
      const result = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(result?.error || 'Notification retry failed');
      setMessage('Notification retry started');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not retry notifications'); }
    finally { setRetrying(false); }
  }

  return <div style={{display:'grid',gap:6,minWidth:190}}>
    <select aria-label="Fulfilment status" value={status} onChange={e=>setStatus(e.target.value)} disabled={statuses.length < 2}>{statuses.map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select>
    {!isEsim && <>
      <input aria-label="Courier tracking" placeholder="Courier tracking / delivery reference" value={courier} onChange={e=>setCourier(e.target.value)} />
      <input aria-label="Return tracking" placeholder="Return tracking / receipt reference" value={returned} onChange={e=>setReturned(e.target.value)} />
      <select aria-label="Pocket WiFi inventory item" value={inventoryItem} onChange={e=>setInventoryItem(e.target.value)} disabled={Boolean(inventoryItemId)}>
        <option value="">Select device / stock item</option>
        {inventoryItems.map(item => <option key={item.id} value={item.id} disabled={item.quantity_on_hand < 1 && item.id !== inventoryItemId}>{item.sku} · {item.name} ({item.quantity_on_hand} available)</option>)}
      </select>
    </>}
    {isEsim && <small>Mark fulfilled after the QR code / activation instructions have been sent to the customer.</small>}
    <button type="button" onClick={save} disabled={saving || statuses.length < 2}>{saving ? 'Saving…' : 'Save'}</button>
    <button type="button" onClick={retryNotifications} disabled={retrying}>{retrying ? 'Retrying notifications…' : 'Retry order notifications'}</button>
    {message && <small aria-live="polite">{message}</small>}
  </div>;
}
