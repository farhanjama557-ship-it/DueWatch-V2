import { useEffect, useMemo, useRef, useState } from 'react'
import { loadFounderReviewReadModel } from '../../lib/companyBrain/founderReviewLoader'
import { createAskDwDurableLiveConversationRuntime } from '../../lib/dwIntelligence/askDwDurableConversationRuntime'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import './AskDwInvoiceLiveProbe.css'

const DEFAULT_QUESTION = 'What needs my attention here?'

function safeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function conversationIdFor(tenantId, invoiceId) {
  const key = `ask-dw:g7:${tenantId}:${invoiceId}`
  try {
    const existing = globalThis.sessionStorage?.getItem(key)
    if (existing) return existing
    const created = randomId('conversation')
    globalThis.sessionStorage?.setItem(key, created)
    return created
  } catch {
    return randomId('conversation')
  }
}

function verificationCopy(verdict) {
  if (verdict === 'PASS') return 'Verified'
  if (verdict === 'REVISE') return 'Answer withheld'
  if (verdict === 'BLOCK') return 'Blocked safely'
  return 'Not verified'
}

function productError(error) {
  if (error?.code === 'GROQ_RATE_LIMITED') return error.message
  const value = String(error?.message || '')
  if (/tenant mismatch|authentication|authenticated/i.test(value)) {
    return 'I could not verify this conversation against your current account. Refresh and try again.'
  }
  if (/stale|changed in another session/i.test(value)) {
    return 'This conversation changed in another session. Reload it before continuing.'
  }
  if (/model|provider|structured|function/i.test(value)) {
    return 'I can’t complete a verified answer right now because the reasoning service is unavailable. I have not guessed or taken action.'
  }
  return 'I couldn’t complete a verified answer from the current sources. Nothing was changed or sent.'
}

function Answer({ message }) {
  const result = message.result
  const answer = result?.askDw?.answer ?? null
  const verification = result?.askDw?.verification ?? null
  const evidence = safeList(answer?.evidenceBasis)
  const limitations = safeList(answer?.uncertaintyAndLimitations)
  const work = safeList(result?.askDw?.reasoningTrail)
    .filter((entry) => entry?.observable === true && entry?.summary)
  const conclusion = answer?.executiveConclusion || result?.reason || message.text

  return (
    <article className="ask-dw-live-probe__message is-dw">
      <div className="ask-dw-live-probe__answer-head">
        <span className={`ask-dw-live-probe__verification is-${String(verification?.verdict || 'unknown').toLowerCase()}`}>
          {verificationCopy(verification?.verdict)}
        </span>
        <span className="ask-dw-live-probe__answer-label">DW</span>
      </div>
      <p className="ask-dw-live-probe__conclusion">{conclusion}</p>

      {answer?.recommendationOrNextStep && (
        <div className="ask-dw-live-probe__recommendation">
          <strong>Next step</strong>
          <p>{answer.recommendationOrNextStep}</p>
        </div>
      )}

      {limitations.length > 0 && (
        <div className="ask-dw-live-probe__limits">
          <strong>What I can’t confirm yet</strong>
          <ul>{limitations.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
        </div>
      )}

      {(evidence.length > 0 || work.length > 0) && (
        <details className="ask-dw-live-probe__details">
          <summary>Evidence and checks</summary>
          {evidence.length > 0 && (
            <ul>{evidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          )}
          {work.length > 0 && (
            <ul className="ask-dw-live-probe__work">
              {work.map((item, index) => <li key={`${index}-${item.summary}`}>{item.summary}</li>)}
            </ul>
          )}
        </details>
      )}
    </article>
  )
}

export default function AskDwInvoiceLiveProbe({ invoiceId, invoiceIds = null }) {
  const { user } = useAuth()
  const runtime = useMemo(
    () => createAskDwDurableLiveConversationRuntime({ supabase }),
    [],
  )
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [mode, setMode] = useState('normal')
  const [messages, setMessages] = useState([])
  const [error, setError] = useState('')
  const [degraded, setDegraded] = useState('')
  const [busy, setBusy] = useState(false)
  const conversationId = useRef(null)

  useEffect(() => {
    conversationId.current = user?.id && invoiceId
      ? conversationIdFor(user.id, invoiceId)
      : null
    setMessages([])
    setError('')
    setDegraded('')
  }, [invoiceId, user?.id])

  if (!invoiceId || !user?.id) return null

  async function runAskDw(event) {
    event?.preventDefault?.()
    const text = question.trim()
    if (!text || busy) return

    setBusy(true)
    setError('')
    setDegraded('')
    setMessages((current) => [...current, { id: randomId('founder'), role: 'founder', text }])
    setQuestion('')

    let companyBrainReadModel = null
    try {
      const loaded = await loadFounderReviewReadModel({ client: supabase, now: new Date() })
      companyBrainReadModel = loaded.readModel
    } catch {
      setDegraded('Company Brain is unavailable for this turn. I will not present it as empty or current.')
    }

    try {
      const response = await runtime.runConversationTurn({
        tenantId: user.id,
        conversationId: conversationId.current || conversationIdFor(user.id, invoiceId),
        caseId: 'invoice-detail',
        turnId: randomId('turn'),
        initialInvoiceId: invoiceId,
        initialInvoiceIds: safeList(invoiceIds).length > 0 ? invoiceIds : [invoiceId],
        mode,
        text,
        now: new Date(),
        companyBrainReadModel,
      })
      setMessages((current) => [...current, {
        id: randomId('dw'), role: 'dw', text: response.reason || '', result: response,
      }])
    } catch (runError) {
      setError(productError(runError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ask-dw-live-probe" aria-label="Ask DW conversation">
      <div className="ask-dw-live-probe__header">
        <div>
          <span className="ask-dw-live-probe__eyebrow">DW Intelligence</span>
          <h3>Ask DW</h3>
        </div>
        <span className="ask-dw-live-probe__badge">Read only</span>
      </div>

      <p className="ask-dw-live-probe__copy">
        Ask naturally. DW checks current records, Company Brain, and authority before answering. Conversation alone never changes money or grants permission.
      </p>

      <div className="ask-dw-live-probe__modes" aria-label="Answer depth">
        <button
          type="button"
          className={mode === 'normal' ? 'is-active' : ''}
          aria-pressed={mode === 'normal'}
          onClick={() => setMode('normal')}
          disabled={busy}
        >
          Normal <span>Concise answer</span>
        </button>
        <button
          type="button"
          className={mode === 'deep' ? 'is-active' : ''}
          aria-pressed={mode === 'deep'}
          onClick={() => setMode('deep')}
          disabled={busy}
        >
          Deep <span>More evidence and alternatives</span>
        </button>
      </div>

      {messages.length > 0 && (
        <div className="ask-dw-live-probe__conversation" aria-live="polite">
          {messages.map((message) => message.role === 'founder' ? (
            <article key={message.id} className="ask-dw-live-probe__message is-founder">
              <span>You</span>
              <p>{message.text}</p>
            </article>
          ) : <Answer key={message.id} message={message} />)}
        </div>
      )}

      {degraded && <div className="ask-dw-live-probe__notice" role="status">{degraded}</div>}
      {error && <div className="ask-dw-live-probe__error" role="alert">{error}</div>}

      <form onSubmit={runAskDw}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          disabled={busy}
          placeholder="Ask about this invoice, a client, today’s priorities, Company Brain, or DW’s authority…"
          aria-label="Ask DW question"
        />
        <div className="ask-dw-live-probe__actions">
          <span>{busy ? 'Checking current sources and verification…' : `${mode === 'deep' ? 'Deep' : 'Normal'} keeps the same truth and safety floor.`}</span>
          <button type="submit" disabled={busy || !question.trim()}>
            {busy ? 'Checking…' : 'Ask DW'}
          </button>
        </div>
      </form>
    </section>
  )
}
