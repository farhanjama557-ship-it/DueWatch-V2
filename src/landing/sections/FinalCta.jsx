import { finalCta } from '../content/duewatchContent'
import styles from './FinalCta.module.css'

/**
 * Static Phase 1 markup. Real Supabase wiring (a new early_access_signups
 * table, insert-only RLS for anon) is a later phase — this form does not
 * submit anywhere yet and must not be made to fake a success state before
 * that exists.
 */
export default function FinalCta() {
  return (
    <section id="final-cta" className={styles.section} aria-labelledby="final-cta-heading">
      <h2 id="final-cta-heading" className={styles.headline}>
        {finalCta.headline}
      </h2>
      <p className={styles.supporting}>{finalCta.supporting}</p>

      <form className={styles.form} aria-describedby="final-cta-privacy">
        <label className={styles.label} htmlFor="early-access-email">
          {finalCta.formLabel}
        </label>
        <div className={styles.fieldRow}>
          <input
            id="early-access-email"
            className={styles.input}
            type="email"
            placeholder={finalCta.placeholder}
            autoComplete="email"
            required
          />
          <button type="submit" className={styles.button}>
            {finalCta.button}
          </button>
        </div>
        <p id="final-cta-privacy" className={styles.privacyLine}>
          {finalCta.privacyLine}
        </p>
      </form>
    </section>
  )
}
