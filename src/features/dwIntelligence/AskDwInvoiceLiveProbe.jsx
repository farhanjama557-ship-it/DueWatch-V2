import { useMemo, useState } from 'react'
import { createAskDwControlledActivationRuntime } from '../../lib/dwIntelligence/askDwControlledActivation'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import './AskDwInvoiceLiveProbe.css'

const DEFAULT_QUESTION = 'What is the current balance on this invoice? Summarize its recent activity.'

export default function AskDwInvoiceLiveProbe({ invoiceId }) {
  const { user } = useAuth()
  const runtime = useMemo(
    () => createAskDwControlledActivationRuntime({ supabase }),
    []
  )
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // First production activation surface remains development-only.
  // It deliberately disappears from production builds.
  if (!import.meta.env.DEV) return null
  if (!invoiceId || !user?.id) return null

  async function runAskDw() {
    const text = question.trim()
    if (!text || busy) return

    setBusy(true)
    setError('')
    setResult(null)

    try {
      const response = await runtime.runInvoiceQuestion({
        tenantId: user.id,
        invoiceId,
        mode: 'normal',
        text,
        now: new Date(),
      })
      setResult(response)
    } catch (err) {
      setError(err?.message || 'Ask DW could not complete the test request.')
    } finally {
      setBusy(false)
    }
  }

  const answer = result?.answer || result?.finalAnswer || result?.narrative || null
  const verification = result?.verification || result?.verifier || null
  const receipt = result?.activationReceipt || null
  const provider = result?.provider || null

  return (
    <section className="ask-dw-live-probe" aria-label="Ask DW live model test">
      <div className="ask-dw-live-probe__header">
        <div>
          <span className="ask-dw-live-probe__eyebrow">DEV - controlled activation</span>
          <h3>Ask DW - GPT-OSS 120B</h3>
        </div>
        <span className="ask-dw-live-probe__badge">Read only</span>
      </div>

      <p className="ask-dw-live-probe__copy">
        Real Groq-backed reasoning for this invoice. Normal mode only. No financial writes or execution authority.
      </p>

      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        rows={4}
        disabled={busy}
        aria-label="Ask DW question"
      />

      <div className="ask-dw-live-probe__actions">
        <button type="button" onClick={runAskDw} disabled={busy || !question.trim()}>
          {busy ? 'Asking DW...' : 'Ask DW'}
        </button>
      </div>

      {error && (
        <div className="ask-dw-live-probe__error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="ask-dw-live-probe__result">
          <div className="ask-dw-live-probe__section">
            <strong>Answer</strong>
            <pre>{JSON.stringify(answer ?? result, null, 2)}</pre>
          </div>

          <div className="ask-dw-live-probe__grid">
            <div>
              <strong>Verification</strong>
              <pre>{JSON.stringify(verification, null, 2)}</pre>
            </div>
            <div>
              <strong>Activation receipt</strong>
              <pre>{JSON.stringify(receipt, null, 2)}</pre>
            </div>
            <div>
              <strong>Provider receipt</strong>
              <pre>{JSON.stringify(provider, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
