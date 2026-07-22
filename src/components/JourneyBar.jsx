import { useEffect, useRef, useState } from 'react'
import { JOURNEY_STAGES, JOURNEY_LABEL, currentStageIndex, stageStatus } from '../lib/journey'

/**
 * Per-invoice lifecycle tracker (Session 7.5 UI Spec §2). Five dots +
 * connectors: Checked -> Drafted -> Signature -> Sent -> Paid.
 *
 * Motion (all disabled under prefers-reduced-motion, handled in CSS):
 *  - the current stage's dot breathes gently while Autopilot is still
 *    working towards it
 *  - a connector flows/fills once, only on a live stage transition (never
 *    on first mount — a ref tracks the previous index so mount doesn't
 *    fire it)
 *  - the Signature stage gets a pulsing ring specifically when current,
 *    since it is the one stage that needs the founder, not just Autopilot
 *  - Paid is always still — nothing animates once an invoice is done
 */
export default function JourneyBar({ invoice, isPendingSignature = false, hasAutopilotRun = false }) {
  const currentIndex = currentStageIndex(invoice, { isPendingSignature, hasAutopilotRun })
  const prevIndexRef = useRef(currentIndex)
  const [justAdvancedFrom, setJustAdvancedFrom] = useState(null)

  useEffect(() => {
    const prev = prevIndexRef.current
    if (currentIndex > prev) {
      setJustAdvancedFrom(prev)
      const t = setTimeout(() => setJustAdvancedFrom(null), 1600)
      prevIndexRef.current = currentIndex
      return () => clearTimeout(t)
    }
    prevIndexRef.current = currentIndex
  }, [currentIndex])

  if (currentIndex < 0) return null

  return (
    <ol className="journey-bar" aria-label="Reminder progress">
      {JOURNEY_STAGES.map((stage, i) => {
        const status = stageStatus(i, currentIndex)
        const isSignature = stage === 'signature'
        const isPaid = stage === 'paid'
        const dotClasses = [
          'journey-dot',
          `journey-dot-${status}`,
          status === 'current' && isSignature ? 'journey-dot-needs-you' : '',
          status === 'current' && !isSignature && !isPaid ? 'journey-dot-breathing' : '',
        ]
          .filter(Boolean)
          .join(' ')
        const connectorStatus = stageStatus(i - 1, currentIndex)
        const connectorClasses =
          justAdvancedFrom === i - 1
            ? 'journey-connector journey-connector-flowing'
            : `journey-connector journey-connector-${connectorStatus}`
        const labelClasses = status === 'current' ? 'journey-label journey-label-current' : 'journey-label'

        return (
          <li key={stage} className="journey-step">
            <div className="journey-dot-row">
              {i > 0 && <span className={connectorClasses} aria-hidden="true" />}
              <span className={dotClasses} aria-hidden="true" />
            </div>
            <span className={labelClasses}>{JOURNEY_LABEL[stage]}</span>
          </li>
        )
      })}
    </ol>
  )
}
