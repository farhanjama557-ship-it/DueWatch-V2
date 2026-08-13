import { useState } from 'react'
import SignatureCard from './SignatureCard'
import { approveSignature, skipSignature } from '../lib/awaitingSignature'
import { logEvent } from '../lib/events'
import { useAuth } from '../context/AuthContext'

// Post-2A.1 execution safety checkpoint (BLOCKER 1): approveSignature()
// now routes through the same durable execution boundary the scheduler
// uses, and the send-reminder-email Edge Function itself writes the
// truthful `events` row server-side, atomically with the actual outcome
// (sent/failed/uncertain) — this component no longer logs a client-side
// "reminder_sent" event, since the browser can no longer know the real
// outcome ahead of the server (and previously couldn't distinguish a lost
// claim race or a stale-authority rejection from a real send at all).

/**
 * "Awaiting Your Signature" — always first in the Morning Brief hierarchy,
 * hidden entirely when there's nothing pending.
 */
export default function SignatureSection({ items, onResolved, onEdit, title = 'Awaiting Your Signature' }) {
  const { user } = useAuth()
  const [toast, setToast] = useState('')

  if (items.length === 0) return null

  function showToast(message) {
    setToast(message)
    setTimeout(() => setToast(''), 3000)
  }

  async function handleApprove(item) {
    const result = await approveSignature({ id: item.id })
    if (result.error) return result

    showToast(`Reminder sent to ${item.invoice?.clients?.name || 'client'}`)
    return { error: null }
  }

  async function handleSkip(item, reason) {
    const result = await skipSignature({ id: item.id, reason })
    if (result.error) return result

    logEvent('reminder_skipped', {
      userId: user.id,
      invoiceId: item.invoice_id,
      lifecycleStage: 'skipped',
      lifecycleState: 'skipped',
      evidence: { reason },
    })
    return { error: null }
  }

  return (
    <section className="signature-section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        <span className="section-count">{items.length}</span>
      </div>
      <ul className="signature-list">
        {items.map((item) => (
          <SignatureCard
            key={item.id}
            item={item}
            onApprove={handleApprove}
            onSkip={handleSkip}
            onEdit={onEdit}
            onResolved={onResolved}
          />
        ))}
      </ul>
      {toast && (
        <div className="signature-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  )
}
