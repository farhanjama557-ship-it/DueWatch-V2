import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useData, balanceOf } from '../../context/DataContext'
import { formatMoney, formatShortDate, daysOverdue, daysUntil } from '../../lib/format'
import { fetchAutopilotRules } from '../../lib/autopilot'
import { nextScheduledAction } from '../../lib/ruleSchedule'
import { TONES, reminderDraft, sendReminderNow } from '../../lib/reminders'
import { logEvent } from '../../lib/events'
import DuewatchBotMark from '../../components/presence/DuewatchBotMark'
import { tokenizeDraft, computeRevealSchedule } from './draftReveal'
import { cognitiveComposeReducer, initialComposeState } from './cognitiveComposeReducer'
import { useCancellableRun, sleep } from '../../hooks/useCancellableSequence'
import '../../styles/presence.css'
import '../../styles/presence-reduced-motion.css'

const STATUS_MIN_TOTAL_MS = 1400 // deliberate legibility window (correction #4) — not a claim the backend needed this long
const CAPITALIZE = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const TONE_LABEL = { friendly: 'Friendly', professional: 'Professional', firm: 'Firm' }

function ruleLabelFor(name) {
  const lower = name.toLowerCase()
  return /\brule$/.test(lower) ? lower : `${lower} rule`
}

function overdueSummaryFor(invoice, matched) {
  if (matched?.eligible && matched.rule.trigger_type === 'before_due') {
    const until = daysUntil(invoice.due_date)
    return `${until} ${until === 1 ? 'day' : 'days'} before due`
  }
  const overdueBy = daysOverdue(invoice.due_date)
  if (overdueBy > 0) return `${overdueBy} ${overdueBy === 1 ? 'day' : 'days'} overdue`
  return null
}

function workStatusLines({ invoiceNumber, overdueSummary, ruleLabel, toneLabel }) {
  const lines = [`Reviewing invoice ${invoiceNumber}…`]
  if (ruleLabel && overdueSummary) {
    lines.push(`${CAPITALIZE(overdueSummary)} — applying your ${ruleLabel}.`)
    lines.push(`Preparing a ${toneLabel} reminder…`)
  } else {
    lines.push(`Preparing the selected ${toneLabel} reminder…`)
  }
  return lines
}

/**
 * The reminder-drafting modal opened from "Draft Reminder" (Dashboard) or
 * "Send reminder" (InvoiceDetailPanel, when there's no signatureContext —
 * an Autopilot-recommended draft still uses InvoiceDetailPanel's existing
 * "Edit First" inline flow, not this component).
 *
 * Honest by construction: the work-status lines only ever name a rule that
 * actually matched (via the same nextScheduledAction() used elsewhere) and
 * the tone actually selected — never a fabricated one. Generation in this
 * app is a synchronous local template, not a real backend call, so the
 * "generating" phase's minimum duration is a disclosed legibility choice,
 * not a claim that a server was doing work for that long.
 *
 * Known, deliberate gaps (flagged, not silently done): global Presence is
 * not forced into Contextual while this modal is in review, and JourneyBar
 * does not gain a transient Drafted/Signature state for it — both of those
 * signals are only backed by real awaiting_signature rows, which a
 * founder-initiated draft never creates. Faking either would violate the
 * "never faked" signal rule the rest of the Presence System follows.
 */
export default function CognitiveCompose({ invoice, onClose, onSent }) {
  const { user } = useAuth()
  const { startCognitive, stopCognitive } = useData()
  const [state, dispatch] = useReducer(cognitiveComposeReducer, initialComposeState)
  const [statusIndex, setStatusIndex] = useState(0)
  const [revealedCount, setRevealedCount] = useState(0)
  const [matchedRule, setMatchedRule] = useState(null)
  const [skipReveal, setSkipReveal] = useState(false)
  const [generationKey, setGenerationKey] = useState(0)
  const run = useCancellableRun()
  const skipRef = useRef(false)
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )

  const clientName = invoice?.clients?.name || 'No client'
  const balance = invoice ? balanceOf(invoice) : 0
  const tokens = useMemo(() => tokenizeDraft(state.draft), [state.draft])
  const schedule = useMemo(() => computeRevealSchedule(tokens), [tokens])

  function draftFor(tone) {
    return reminderDraft(tone, {
      clientName,
      invoiceNumber: invoice.invoice_number,
      balance: formatMoney(balance),
      dueDate: formatShortDate(invoice.due_date),
    })
  }

  // Fetch real Autopilot rules once, to know honestly whether one matches
  // this invoice right now — never fabricated.
  useEffect(() => {
    if (!invoice || !user) return
    let cancelled = false
    fetchAutopilotRules(user.id).then((rules) => {
      if (cancelled) return
      setMatchedRule(nextScheduledAction(rules, invoice))
    })
    return () => {
      cancelled = true
    }
  }, [invoice, user])

  // Drive the generating -> revealing -> review sequence.
  useEffect(() => {
    if (!invoice) return
    previousFocusRef.current = document.activeElement
    skipRef.current = false
    setSkipReveal(false)
    setStatusIndex(0)
    setRevealedCount(0)

    const initialTone = matchedRule?.eligible ? matchedRule.rule.tone : 'friendly'
    dispatch({ type: 'OPEN', tone: initialTone })

    run(async (signal) => {
      startCognitive(`Drafting reminder for ${clientName}`)

      const overdueSummary = overdueSummaryFor(invoice, matchedRule)
      const ruleLabel = matchedRule?.eligible ? ruleLabelFor(matchedRule.rule.name) : null
      const lines = workStatusLines({
        invoiceNumber: invoice.invoice_number || 'your invoice',
        overdueSummary,
        ruleLabel,
        toneLabel: TONE_LABEL[initialTone] || CAPITALIZE(initialTone),
      })

      const start = Date.now()
      if (!reducedMotion) {
        setStatusIndex(0)
        await sleep(550, signal)
        setStatusIndex(1)
        if (lines.length > 2) {
          await sleep(700, signal)
          setStatusIndex(2)
        }
      }

      const draft = draftFor(initialTone)

      if (!reducedMotion) {
        const elapsed = Date.now() - start
        if (elapsed < STATUS_MIN_TOTAL_MS) await sleep(STATUS_MIN_TOTAL_MS - elapsed, signal)
      }

      stopCognitive()
      dispatch({ type: 'DRAFT_READY', draft })
      // Matches the existing Activity-log behavior for every other draft
      // entry point in the app (shows as "Drafted a reminder").
      logEvent('reminder_opened', { userId: user.id, invoiceId: invoice.id })

      if (reducedMotion) {
        setRevealedCount(tokenizeDraft(draft).length)
        dispatch({ type: 'REVEAL_DONE' })
        return
      }

      const toks = tokenizeDraft(draft)
      const sched = computeRevealSchedule(toks)
      for (let i = 0; i < toks.length; i++) {
        if (skipRef.current) break
        setRevealedCount(i + 1)
        await sleep(sched[i], signal)
      }
      setRevealedCount(toks.length)
      dispatch({ type: 'REVEAL_DONE' })
    })

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id, matchedRule, generationKey])

  useEffect(() => {
    if (!invoice) return
    dialogRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape' && state.phase !== 'sending') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice, state.phase])

  if (!invoice) return null

  function handleClose() {
    if (state.phase === 'sending') return
    stopCognitive()
    dispatch({ type: 'CLOSE' })
    onClose?.()
    if (previousFocusRef.current instanceof HTMLElement) previousFocusRef.current.focus()
  }

  function handleShowFullDraft() {
    skipRef.current = true
    setSkipReveal(true)
    if (state.draft) {
      setRevealedCount(tokens.length)
      dispatch({ type: 'REVEAL_DONE' })
    }
  }

  // Generation is a synchronous local template today, so this path is not
  // actually reachable yet — kept so the state machine stays complete if
  // draft generation ever becomes a real call that can fail.
  function handleRetryDraft() {
    setGenerationKey((k) => k + 1)
  }

  function handlePickTone(tone) {
    dispatch({ type: 'PICK_TONE', tone, draft: draftFor(tone) })
  }

  async function handleApproveSend() {
    dispatch({ type: 'SEND_START' })
    startCognitive(`Sending reminder to ${clientName}`)
    const result = await sendReminderNow({ userId: user.id, invoice, draft: state.draft })
    stopCognitive()
    if (result.error) {
      dispatch({ type: 'SEND_ERROR', message: result.error })
      return
    }
    dispatch({ type: 'SEND_SUCCESS' })
    onSent?.(result)
    setTimeout(handleClose, 1400)
  }

  const visibleTokens = tokens.slice(0, revealedCount)
  const revealing = state.phase === 'revealing' && !reducedMotion && !skipReveal

  return (
    <div className="cc-overlay" onClick={handleClose}>
      <div
        ref={dialogRef}
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cc-header">
          <DuewatchBotMark cognitive={state.phase === 'generating' || state.phase === 'sending'} />
          <h2 id="cc-title" className="cc-title">
            {state.phase === 'generating' && 'Duewatch is preparing your reminder'}
            {(state.phase === 'revealing' || state.phase === 'review' || state.phase === 'editing') &&
              (revealing ? 'Your reminder is ready' : 'Ready for your signature')}
            {state.phase === 'sending' && 'Sending your approved reminder'}
            {state.phase === 'sent' && 'Reminder sent'}
            {state.phase === 'error' && state.errorKind === 'draft' && "I couldn't prepare this reminder"}
            {state.phase === 'error' && state.errorKind === 'send' && "I couldn't send this reminder"}
          </h2>
          <button
            type="button"
            className="cc-close"
            onClick={handleClose}
            aria-label="Close reminder composer"
            disabled={state.phase === 'sending'}
          >
            <X size={16} />
          </button>
        </div>

        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {state.phase === 'generating' && 'Preparing reminder.'}
          {state.phase === 'review' && 'Draft ready for review.'}
          {state.phase === 'sending' && 'Sending approved reminder.'}
          {state.phase === 'sent' && 'Reminder sent.'}
          {state.phase === 'error' && state.errorKind === 'send' && 'Reminder could not be sent.'}
        </div>

        {state.phase === 'generating' && (
          <div className="cc-status">
            {workStatusLines({
              invoiceNumber: invoice.invoice_number || 'your invoice',
              overdueSummary: overdueSummaryFor(invoice, matchedRule),
              ruleLabel: matchedRule?.eligible ? ruleLabelFor(matchedRule.rule.name) : null,
              toneLabel: TONE_LABEL[state.tone] || CAPITALIZE(state.tone),
            })
              .slice(0, reducedMotion ? undefined : statusIndex + 1)
              .map((line, i) => (
                <p key={i} className="cc-status-line">
                  {line}
                </p>
              ))}
            <button type="button" className="btn-ghost cc-skip" onClick={handleShowFullDraft}>
              {skipReveal ? "I'll show the full draft when it's ready." : 'Show full draft'}
            </button>
          </div>
        )}

        {(state.phase === 'revealing' || state.phase === 'review' || state.phase === 'editing') && (
          <>
            {matchedRule?.eligible && (
              <p className="cc-subline">
                I prepared this using your {ruleLabelFor(matchedRule.rule.name)}.
              </p>
            )}
            <div className="cc-draft-viewport">
              {state.phase === 'editing' ? (
                <div className="action-form">
                  <div className="tone-buttons">
                    {TONES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={state.tone === t ? 'tone-btn active' : 'tone-btn'}
                        onClick={() => handlePickTone(t)}
                      >
                        {CAPITALIZE(t)}
                      </button>
                    ))}
                  </div>
                  <textarea
                    id="cc-draft-textarea"
                    aria-label="Reminder message"
                    rows={8}
                    value={state.draft}
                    onChange={(e) => dispatch({ type: 'EDIT_CHANGE', draft: e.target.value })}
                  />
                </div>
              ) : (
                <>
                  <pre aria-hidden="true" className="cc-draft-text">
                    {revealing
                      ? visibleTokens.map((t, i) => (
                          <span key={i} className="cc-token">
                            {t.text}
                          </span>
                        ))
                      : state.draft}
                    {revealing && <span className="cc-caret" />}
                  </pre>
                  {revealing && <p className="sr-only">Draft is being prepared for review.</p>}
                </>
              )}
            </div>
            {state.phase === 'revealing' && (
              <button
                type="button"
                className="btn-ghost cc-skip"
                onClick={handleShowFullDraft}
                aria-label="Skip the visual reveal and show the complete draft"
              >
                Show full draft
              </button>
            )}
            {state.phase === 'review' && (
              <p className="cc-subline">Review it, edit it, or approve it before it sends.</p>
            )}
            {(state.phase === 'review' || state.phase === 'editing') && (
              <div className="cc-actions">
                {state.phase === 'review' && (
                  <button type="button" className="btn-outline" onClick={() => dispatch({ type: 'START_EDIT' })}>
                    Edit First
                  </button>
                )}
                <button type="button" className="btn-terracotta" onClick={handleApproveSend}>
                  Approve &amp; Send
                </button>
              </div>
            )}
          </>
        )}

        {state.phase === 'sending' && (
          <div className="cc-status">
            <p className="cc-status-line">Sending your reminder to {clientName}…</p>
          </div>
        )}

        {state.phase === 'sent' && (
          <div className="cc-status">
            <p className="cc-status-line">I recorded the send in Activity.</p>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="cc-status">
            {state.errorMessage && <p className="auth-error">{state.errorMessage}</p>}
            <div className="cc-actions">
              <button type="button" className="btn-outline" onClick={handleClose}>
                Close
              </button>
              <button
                type="button"
                className="btn-terracotta"
                onClick={state.errorKind === 'draft' ? handleRetryDraft : handleApproveSend}
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
