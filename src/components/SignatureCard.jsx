import { useState } from 'react'
import { Bot, CheckCircle, Loader2 } from 'lucide-react'
import Avatar from './Avatar'
import JourneyBar from './JourneyBar'
import { formatMoney, daysOverdue } from '../lib/format'
import { balanceOf, useData } from '../context/DataContext'

const TONE_STYLE = {
  friendly: { label: 'Friendly', color: '#3B82F6', bg: '#EBF2FE' },
  professional: { label: 'Professional', color: '#0F1117', bg: '#F1F2F4' },
  firm: { label: 'Firm', color: '#C2540A', bg: '#FEF0E6' },
}

const SKIP_REASONS = ['Client already paid', "I'll handle manually", 'Wrong timing', 'Other']

/**
 * One glance = full context, one click to act. Stage machine:
 * idle -> signing -> sent -> (exit) | idle -> skip-reason -> skipping -> (exit)
 */
export default function SignatureCard({ item, onApprove, onSkip, onEdit, onResolved }) {
  const { startCognitive, stopCognitive } = useData()
  const [stage, setStage] = useState('idle')
  const [showFullDraft, setShowFullDraft] = useState(false)
  const [skipReason, setSkipReason] = useState(SKIP_REASONS[0])
  const [exiting, setExiting] = useState(false)
  const [error, setError] = useState('')

  const invoice = item.invoice
  const clientName = invoice?.clients?.name || 'No client'
  const od = invoice ? daysOverdue(invoice.due_date) : 0
  const tone = TONE_STYLE[item.recommended_tone] || TONE_STYLE.friendly
  const lines = (item.draft_content || '').split('\n')
  const preview = lines.slice(0, 3).join('\n')
  const hasMore = lines.length > 3

  function exitThenResolve() {
    setExiting(true)
    setTimeout(() => onResolved?.(item.id), 550)
  }

  async function handleApprove() {
    setError('')
    setStage('signing')
    // Real Cognitive signal (Presence System) — this is an actual in-flight
    // send, not a fabricated "thinking" state.
    startCognitive(`Sending reminder to ${clientName}`)
    // Intentional processing feel — not an instant toggle.
    const delay = new Promise((r) => setTimeout(r, 800 + Math.random() * 400))
    const [result] = await Promise.all([onApprove(item), delay])
    stopCognitive()
    if (result?.error) {
      setError(result.error.message)
      setStage('idle')
      return
    }
    setStage('sent')
    setTimeout(exitThenResolve, 1000)
  }

  async function handleSkipConfirm() {
    setError('')
    setStage('skipping')
    const result = await onSkip(item, skipReason)
    if (result?.error) {
      setError(result.error.message)
      setStage('idle')
      return
    }
    exitThenResolve()
  }

  return (
    <li className={exiting ? 'signature-card exiting' : 'signature-card'}>
      <div className="signature-header">
        <Avatar name={clientName} size={36} />
        <div className="signature-header-text">
          <span className="signature-client">{clientName}</span>
          <span className="signature-meta">
            {invoice?.invoice_number || 'No number'} · {formatMoney(invoice ? balanceOf(invoice) : 0)}
            {od > 0 && (
              <>
                {' · '}
                {od} {od === 1 ? 'day' : 'days'} overdue
              </>
            )}
          </span>
        </div>
      </div>

      <div className="signature-reco">
        <span className="signature-reco-label">
          <Bot size={16} color="var(--primary)" /> Autopilot recommends
        </span>
        <span className="tone-pill" style={{ color: tone.color, background: tone.bg }}>
          {tone.label}
        </span>
      </div>
      {item.ai_reason && <p className="signature-reason">{item.ai_reason}</p>}

      <div className="signature-preview">
        <pre>{showFullDraft ? item.draft_content : preview}</pre>
        {hasMore && (
          <button
            type="button"
            className="signature-preview-toggle"
            onClick={() => setShowFullDraft((v) => !v)}
          >
            {showFullDraft ? 'Show less' : 'Show full draft'}
          </button>
        )}
      </div>

      {invoice && (
        <JourneyBar invoice={invoice} isPendingSignature hasAutopilotRun />
      )}

      {error && <div className="auth-error signature-error">{error}</div>}

      {stage === 'skip-reason' ? (
        <div className="signature-skip-form">
          <select value={skipReason} onChange={(e) => setSkipReason(e.target.value)}>
            {SKIP_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <div className="signature-skip-actions">
            <button className="btn-outline" onClick={() => setStage('idle')}>
              Cancel
            </button>
            <button className="btn-outline" onClick={handleSkipConfirm}>
              Confirm skip
            </button>
          </div>
        </div>
      ) : stage === 'sent' ? (
        <div className="signature-sent-state">
          <CheckCircle size={18} color="#15803D" /> Sent
        </div>
      ) : (
        <div className="signature-actions">
          <button
            className="btn-terracotta"
            onClick={handleApprove}
            disabled={stage === 'signing' || stage === 'skipping'}
            aria-label={`Approve and send reminder to ${clientName}`}
          >
            {stage === 'signing' ? (
              <>
                <Loader2 size={15} className="spin" /> Signing…
              </>
            ) : (
              'Approve & Send'
            )}
          </button>
          <button
            className="btn-outline"
            onClick={() => onEdit(item)}
            disabled={stage !== 'idle'}
          >
            Edit First
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setStage('skip-reason')}
            disabled={stage !== 'idle'}
          >
            Skip
          </button>
        </div>
      )}
    </li>
  )
}
