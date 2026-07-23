import { Check } from 'lucide-react'
import { pricing } from '../content/duewatchContent'
import styles from './Pricing.module.css'

export default function Pricing() {
  return (
    <section id="pricing" className={styles.section} aria-labelledby="pricing-heading">
      <p className={styles.label}>{pricing.label}</p>
      <h2 id="pricing-heading" className={styles.headline}>
        {pricing.headline}
      </h2>
      <p className={styles.supporting}>{pricing.supporting}</p>

      <div className={styles.plans}>
        <div className={styles.plan}>
          <span className={styles.planLabel}>{pricing.free.label}</span>
          <h3>Free</h3>
          <p className={styles.planBody}>{pricing.free.body}</p>
          <p className={styles.planDetail}>{pricing.free.detail}</p>
          <a className={styles.planCta} href="#final-cta">
            {pricing.free.cta}
          </a>
        </div>

        <div className={styles.plan}>
          <span className={styles.planLabel}>{pricing.pro.label}</span>
          <h3>Pro</h3>
          <p className={styles.planBody}>{pricing.pro.body}</p>
          <ul className={styles.featureList}>
            {pricing.pro.features.map((f) => (
              <li key={f}>
                <Check size={14} aria-hidden="true" />
                {f}
              </li>
            ))}
          </ul>
          <a className={styles.planCta} href="#final-cta">
            {pricing.pro.cta}
          </a>
        </div>
      </div>

      <p className={styles.trialLine}>{pricing.trialLine}</p>
    </section>
  )
}
