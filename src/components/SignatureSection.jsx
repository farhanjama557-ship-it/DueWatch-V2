import { useState } from 'react'
import SignatureCard from './SignatureCard'
import { approveSignature, skipSignature } from '../lib/awaitingSignature'
import { logEvent } from '../lib/events'
import { useAuth } from '../context/AuthContext'

/**
 * "Awaiting Your Signature" — always first in the Morning Brief hierarchy,
 * hidden entirely when there's nothing pending.
 */
export default function SignatureSection({ items, onResolved, onEdit }) {
  const { user } = useAuth()
  const [toast, setToast] = useState('')

  if (items.length === 0) return null

  function showToast(message) {
    setToast(message)
    setTimeout(() => setToast(''), 3000)
  }

  async function handleApprove(item) {
    const result = await approveSignature({
      id: item.id,
      invoiceId: item.invoice_id,
      userId: user.id,
      draftContent: item.draft_content,
    })
    if (result.error) return result

    logEvent('reminder_sent', {
      userId: user.id,
      invoiceId: item.invoice_id,
      lifecycleStage: 'sent',
      lifecycleState: 'completed',
      evidence: {
        reason: item.ai_reason,
        trigger: 'Autopilot recommendation',
        approved_by: 'You',
        resend_id: result.resendId || null,
        delivery_status: 'sent',
      },
    })
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
        <h2 className="section-title">Awaiting Your Signature</h2>
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
