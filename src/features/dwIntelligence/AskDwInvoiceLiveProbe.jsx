import { useMemo, useState } from 'react'
import { createAskDwControlledActivationRuntime } from '../../lib/dwIntelligence/askDwControlledActivation'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import './AskDwInvoiceLiveProbe.css'

const DEFAULT_QUESTION = 'What is the current balance on this invoice? Summarize its recent activity.'

function safeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function verificationCopy(verdict) {
  if (verdict === 'PASS') return 'Verified'
  if (verdict === 'REVISE') return 'Needs revision'
  if (verdict === 'BLOCK') return 'Blocked'
  return 'Not verified'
}

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
  const conclusion = answer?.executiveConclusion || null
  const evidence = safeList(answer?.evidenceBasis)
  const limitations = safeList(answer?.uncertaintyAndLimitations)
  const recommendation = answer?.recommendationOrNextStep || null
  const verificationIssues = safeList(verification?.issues)
  const checkedClaims = safeList(verification?.checkedClaims)
  const verdict = verification?.verdict || null
  const technicalDetails = result ? {
    citedToolRunIds: safeList(answer?.citedToolRunIds),
    activationReceipt: receipt,
    providerReceipt: provider,
    toolRuns: safeList(result?.toolRuns).map((run) => ({
      id: run?.id ?? null,
      name: run?.output?.name ?? run?.request?.name ?? null,
      sourceClass: run?.output?.sourceClass ?? null,
      canonicalAuthority: run?.output?.canonicalAuthority ?? null,
    })),
  } : null

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
          <div className="ask-dw-live-probe__answer-head">
            <span className={`ask-dw-live-probe__verification is-${String(verdict || 'unknown').toLowerCase()}`}>
              {verificationCopy(verdict)}
            </span>
            <span className="ask-dw-live-probe__answer-label">Answer</span>
          </div>

          {conclusion ? (
            <p className="ask-dw-live-probe__conclusion">{conclusion}</p>
          ) : (
            <p className="ask-dw-live-probe__conclusion">Ask DW completed without a user-facing conclusion.</p>
          )}

          {recommendation && (
            <div className="ask-dw-live-probe__recommendation">
              <strong>Next step</strong>
              <p>{recommendation}</p>
            </div>
          )}

          {limitations.length > 0 && (
            <div className="ask-dw-live-probe__limits">
              <strong>What DueWatch cannot confirm yet</strong>
              <ul>
                {limitations.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
              </ul>
            </div>
          )}

          <details className="ask-dw-live-probe__details">
            <summary>Evidence</summary>
            {evidence.length > 0 ? (
              <ul>
                {evidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
              </ul>
            ) : (
              <p>No additional evidence summary was returned.</p>
            )}
          </details>

          <details className="ask-dw-live-probe__details">
            <summary>Verification</summary>
            <div className="ask-dw-live-probe__verification-body">
              <p><strong>Verdict:</strong> {verificationCopy(verdict)}</p>
              {verificationIssues.length > 0 && (
                <>
                  <strong>Issues</strong>
                  <ul>
                    {verificationIssues.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                  </ul>
                </>
              )}
              {checkedClaims.length > 0 && (
                <>
                  <strong>Checked claims</strong>
                  <ul>
                    {checkedClaims.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                  </ul>
                </>
              )}
            </div>
          </details>

          <details className="ask-dw-live-probe__details ask-dw-live-probe__technical">
            <summary>Technical details</summary>
            <pre>{JSON.stringify(technicalDetails, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  )
}
