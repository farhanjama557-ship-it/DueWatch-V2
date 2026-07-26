import { evidence } from '../content/duewatchContent'
import { evidenceTrail } from '../content/demoData'
import { EVIDENCE_ICON } from '../ui/icons'
import styles from './Evidence.module.css'

/**
 * Static work-log timeline. `opened` is absent from the default demo data
 * on purpose (open tracking isn't confirmed live) — the layout must read
 * as complete without it, which this markup already satisfies since
 * nothing here reserves space for it.
 */
export default function Evidence() {
  return (
    <section id="evidence" className={styles.section} aria-labelledby="evidence-heading">
      <div className={styles.copy}>
        <p className={styles.label}>{evidence.label}</p>
        <h2 id="evidence-heading" className={styles.headline}>
          {evidence.headline}
        </h2>
        <p className={styles.supporting}>{evidence.supporting}</p>
      </div>

      <ol className={styles.trail}>
        {evidenceTrail.map((event) => {
          const Icon = EVIDENCE_ICON[event.type]
          return (
            <li key={event.type} className={styles.event}>
              <span className={styles.dot} aria-hidden="true">
                <Icon size={14} />
              </span>
              <div className={styles.eventBody}>
                <div className={styles.eventTop}>
                  <span className={styles.eventType}>{event.type.replace(/_/g, ' ')}</span>
                  <span className={styles.eventMeta}>
                    {event.actor} · {event.timestamp}
                  </span>
                </div>
                <p className={styles.eventMessage}>{event.message}</p>
                <span className={styles.eventOutcome}>{event.outcome}</span>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
