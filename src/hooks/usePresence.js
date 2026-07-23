import { useEffect, useRef, useState } from 'react'

const COGNITIVE_MAX_MS = 5000
const CELEBRATORY_MS = 10000

/**
 * Priority chain, highest first (Merged Spec v1.1 §3/§7):
 *   Celebratory > Error > Active > Contextual > Cognitive > Resting > Off
 *
 * `autopilotUnexpectedlyPaused` has no real signal anywhere in this
 * codebase yet — there's no tracked distinction between "the founder
 * turned it off" and "it stopped unexpectedly". It defaults to false and
 * stays that way until such a signal actually exists; it is never faked
 * just to exercise the Active state.
 */
export function evaluatePresence({
  celebration,
  errorCount = 0,
  criticalOverdueCount = 0,
  autopilotUnexpectedlyPaused = false,
  awaitingSignatureCount = 0,
  cognitiveActivity,
  autopilotEnabled,
}) {
  if (celebration) return 'celebratory'
  if (errorCount > 0) return 'error'
  if (criticalOverdueCount > 0 || autopilotUnexpectedlyPaused) return 'active'
  if (awaitingSignatureCount > 0) return 'contextual'
  if (cognitiveActivity) return 'cognitive'
  if (autopilotEnabled) return 'resting'
  return 'off'
}

/**
 * Drives the Presence System's current state plus the two transient
 * auto-timeouts the spec requires (§4.2, §4.6, §11): Cognitive never shows
 * for more than 5s even if the real operation is still running, and
 * Celebratory always self-dismisses after 10s (via `onCelebrationTimeout`,
 * which the caller uses to clear the real celebration signal so the next
 * evaluation falls through to whatever state is genuinely true).
 */
export default function usePresence(signals, { onCelebrationTimeout } = {}) {
  const {
    celebration,
    errorCount = 0,
    criticalOverdueCount = 0,
    autopilotUnexpectedlyPaused = false,
    awaitingSignatureCount = 0,
    cognitiveActivity,
    autopilotEnabled,
  } = signals

  const [state, setState] = useState(() => evaluatePresence(signals))
  const timeoutRef = useRef(null)

  useEffect(() => {
    const next = evaluatePresence(signals)
    setState(next)
    clearTimeout(timeoutRef.current)

    if (next === 'cognitive') {
      timeoutRef.current = setTimeout(() => {
        setState(evaluatePresence({ ...signals, cognitiveActivity: null }))
      }, COGNITIVE_MAX_MS)
    } else if (next === 'celebratory') {
      timeoutRef.current = setTimeout(() => {
        onCelebrationTimeout?.()
      }, CELEBRATORY_MS)
    }

    return () => clearTimeout(timeoutRef.current)
    // signals is destructured above; re-run whenever any real input changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    celebration,
    errorCount,
    criticalOverdueCount,
    autopilotUnexpectedlyPaused,
    awaitingSignatureCount,
    cognitiveActivity,
    autopilotEnabled,
  ])

  return state
}
