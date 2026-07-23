import { createContext, useContext, useMemo } from 'react'
import { useData, isOutstanding } from '../context/DataContext'
import usePresence from '../hooks/usePresence'
import { presenceCopy, presenceSrText, PRESENCE_CLICK } from '../lib/presence'

const PresenceContext = createContext(null)

/**
 * Wires the Presence System's priority hook to real app signals from
 * DataContext — no fabricated triggers. See DataContext.jsx for where
 * `cognitiveActivity` and `celebration` are set (real async sends/signs,
 * real payment writes) and `src/lib/presence.js` for the copy/click config.
 */
export function PresenceProvider({ children }) {
  const {
    invoices,
    autopilotEnabled,
    awaitingSignature,
    criticalOverdueCount,
    autopilotErrorCount,
    cognitiveActivity,
    celebration,
    dismissCelebration,
  } = useData()

  const watchingCount = invoices.filter(isOutstanding).length
  const awaitingSignatureCount = awaitingSignature.length

  const state = usePresence(
    {
      celebration,
      errorCount: autopilotErrorCount,
      criticalOverdueCount,
      autopilotUnexpectedlyPaused: false,
      awaitingSignatureCount,
      cognitiveActivity,
      autopilotEnabled,
    },
    { onCelebrationTimeout: dismissCelebration }
  )

  const ctx = {
    watchingCount,
    criticalOverdueCount,
    errorCount: autopilotErrorCount,
    awaitingSignatureCount,
    cognitiveLabel: cognitiveActivity?.label,
    clientName: celebration?.clientName,
    amount: celebration?.amount,
    daysEarly: celebration?.daysEarly,
  }

  const value = useMemo(
    () => ({
      state,
      copy: presenceCopy(state, ctx),
      srText: presenceSrText(state, ctx),
      click: PRESENCE_CLICK[state],
    }),
    // ctx is rebuilt every render from primitives already in the dep list
    // below (plus state) — safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state,
      watchingCount,
      criticalOverdueCount,
      autopilotErrorCount,
      awaitingSignatureCount,
      cognitiveActivity,
      celebration,
    ]
  )

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
}

export function usePresenceContext() {
  const ctx = useContext(PresenceContext)
  if (!ctx) throw new Error('usePresenceContext must be used within a PresenceProvider')
  return ctx
}
