import { hero } from '../content/duewatchContent'
import { heroDemo, evidenceTrail } from '../content/demoData'
import ProductWindow from '../ui/ProductWindow'
import { EVIDENCE_ICON } from '../ui/icons'
import styles from './Hero.module.css'

/**
 * Static Phase 1 markup for the interactive Approve & Send demo. Renders
 * the spec's "Initial state" (Unified Spec §9) — Contextual, complete
 * readable draft, rule/tone visible, evidence preview with Checked+Drafted
 * only. The Pressed → Signing → Cognitive/Sending → Sent → Resting state
 * machine and its motion are a later phase; these are real, keyboard-
 * operable buttons already, just not wired to a timed sequence yet.
 */
export default function Hero() {
  const previewEvents = evidenceTrail.slice(0, 2)

  return (
    <section className={styles.hero} aria-labelledby="hero-headline">
      <div className={styles.headlineBlock}>
        <p className={styles.eyebrow}>{hero.eyebrow}</p>
        <h1 id="hero-headline" className={styles.headline}>
          {hero.headline.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h1>
      </div>

      <div className={styles.copy}>
        <p className={styles.supporting}>{hero.supporting}</p>
        <p className={styles.approvalNote}>{hero.approvalClarification}</p>
        <div className={styles.actions}>
          <a className={styles.primaryCta} href="#final-cta">
            {hero.primaryCta}
          </a>
          <a className={styles.secondaryCta} href="#employee-moment">
            {hero.secondaryCta}
          </a>
        </div>
        <p className={styles.trustLine}>{hero.trustLine}</p>
      </div>

      <div className={styles.demoColumn}>
        <ProductWindow label={hero.demoLabel}>
          <div className={styles.demo}>
            <div className={styles.demoMeta}>
              <span className={styles.demoClient}>{heroDemo.client}</span>
              <span className={styles.demoInvoice}>
                {heroDemo.invoiceNumber} · {heroDemo.amount} · {heroDemo.status}
              </span>
              <span className={styles.demoRule}>
                {heroDemo.rule} · {heroDemo.tone} tone
              </span>
            </div>

            <p className={styles.demoStatus}>{hero.duewatchStatus}</p>

            <pre className={styles.draft}>{heroDemo.draft}</pre>

            <div className={styles.demoActions}>
              <button type="button" className={styles.approveBtn}>
                {hero.actions[0]}
              </button>
              <button type="button" className={styles.secondaryBtn}>
                {hero.actions[1]}
              </button>
              <button type="button" className={styles.ghostBtn}>
                {hero.actions[2]}
              </button>
            </div>

            <ul className={styles.evidencePreview} aria-label="Evidence preview">
              {previewEvents.map((event) => {
                const Icon = EVIDENCE_ICON[event.type]
                return (
                  <li key={event.type}>
                    <Icon size={14} aria-hidden="true" />
                    <span>{event.message}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </ProductWindow>
      </div>
    </section>
  )
}
