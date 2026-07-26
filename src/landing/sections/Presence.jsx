import { useState, useRef } from 'react'
import { presence } from '../content/duewatchContent'
import { presenceStates } from '../content/demoData'
import { PRESENCE_ICON } from '../ui/icons'
import styles from './Presence.module.css'

/**
 * The seven-state manual showcase. A real semantic tablist with working
 * keyboard navigation (arrow keys move focus, Enter/Space select) — this
 * is structure and accessibility, not the "meaningful motion" Phase 2
 * adds per state (ring rotation, ripple, breathe, etc). State swaps here
 * are instant, which is also the correct reduced-motion behavior later.
 */
export default function Presence() {
  const [selectedId, setSelectedId] = useState('Resting')
  const tabRefs = useRef([])

  const selected = presenceStates.find((s) => s.id === selectedId)

  function onKeyDown(e, index) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = (index + dir + presenceStates.length) % presenceStates.length
    setSelectedId(presenceStates[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <section id="presence" className={styles.section} aria-labelledby="presence-heading">
      <div className={styles.copy}>
        <p className={styles.label}>{presence.label}</p>
        <h2 id="presence-heading" className={styles.headline}>
          {presence.headline}
        </h2>
        <p className={styles.supporting}>{presence.supporting}</p>
      </div>

      <div className={styles.showcase}>
        <div className={styles.central} style={{ borderColor: selected.color }}>
          <span className={styles.stateName} style={{ color: selected.color }}>
            {selected.id}
          </span>
          <p className={styles.stateTitle}>{selected.title}</p>
          <p className={styles.stateSubtitle}>{selected.subtitle}</p>
          <p className={styles.stateMeaning}>{selected.meaning}</p>
        </div>

        <div role="tablist" aria-label="Duewatch Presence states" className={styles.rail}>
          {presenceStates.map((state, i) => {
            const Icon = PRESENCE_ICON[state.id]
            const isSelected = state.id === selectedId
            return (
              <button
                key={state.id}
                ref={(el) => (tabRefs.current[i] = el)}
                role="tab"
                type="button"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                className={isSelected ? `${styles.tab} ${styles.tabSelected}` : styles.tab}
                style={isSelected ? { borderColor: state.color, color: state.color } : undefined}
                onClick={() => setSelectedId(state.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                <Icon size={16} aria-hidden="true" />
                {state.id}
              </button>
            )
          })}
        </div>
      </div>

      <p className={styles.closingLine}>{presence.closingLine}</p>
    </section>
  )
}
