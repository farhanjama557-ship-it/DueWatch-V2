import styles from './ProductWindow.module.css'

/**
 * Shared static chrome for the two embedded product demonstrations (Hero,
 * Meet Duewatch). Per the locked framing correction: one stable, centered
 * canvas — camera motion and internal state transitions are Phase 2+; this
 * is the fixed frame they'll eventually animate inside, not a mock of the
 * motion itself.
 */
export default function ProductWindow({ label, wide = false, children }) {
  return (
    <div className={wide ? `${styles.window} ${styles.windowWide}` : styles.window}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.body}>{children}</div>
    </div>
  )
}
