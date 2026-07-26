import { globalVision } from '../content/duewatchContent'
import { globalVisionMoments, currencyFormats } from '../content/demoData'
import styles from './GlobalVision.module.css'

/**
 * Static Phase 1 placeholder. The globe (Natural Earth geometry, lighting,
 * conceptual trace) is a later phase — this renders the locked copy and a
 * real text summary of every illustrative moment now, since that's the
 * accessible fallback content the eventual globe will sit alongside, not
 * something motion adds later.
 */
export default function GlobalVision() {
  return (
    <section id="global-vision" className={styles.section} aria-labelledby="global-vision-heading">
      <p className={styles.label}>{globalVision.label}</p>
      <p className={styles.opening}>
        {globalVision.opening.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </p>

      <h2 id="global-vision-heading" className={styles.lockedLine}>
        {globalVision.lockedLine.map((line, i) => (
          <span key={line} className={i === 2 ? styles.lockedLineAccent : undefined}>
            {line}
          </span>
        ))}
      </h2>

      <p className={styles.vision}>{globalVision.vision}</p>
      <p className={styles.truthLabel}>{globalVision.truthLabel}</p>

      <div className={styles.globePlaceholder} role="img" aria-label="Illustrative world map, to be built in a later phase">
        <span>Globe visualization — later phase</span>
      </div>

      <ul className={styles.momentsList} aria-label="Illustrative business moments">
        {globalVisionMoments.map((m) => (
          <li key={`${m.city}-${m.country}`}>
            <span className={styles.momentLocation}>
              {m.city}, {m.country}
            </span>
            <span className={styles.momentDetail}>
              {m.businessType} · {m.amount} · {m.state}
            </span>
          </li>
        ))}
      </ul>

      <ul className={styles.currencyList} aria-label="Illustrative currency and language formats">
        {currencyFormats.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </section>
  )
}
