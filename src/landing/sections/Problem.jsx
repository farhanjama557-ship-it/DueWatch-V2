import { problem } from '../content/duewatchContent'
import styles from './Problem.module.css'

/**
 * Static Phase 1 markup. The desktop sticky-stage discrete thought changes
 * (Unified Spec §8/§13) are a motion-phase feature — this renders all four
 * thoughts in a calm vertical sequence, which is also the required mobile
 * behavior, so it's a safe, honest default before that motion exists.
 */
export default function Problem() {
  return (
    <section className={styles.problem} aria-labelledby="problem-heading">
      <div className={styles.anchor}>
        <p id="problem-heading" className={styles.label}>
          {problem.label}
        </p>
      </div>

      <div className={styles.stage}>
        <ul className={styles.thoughts}>
          {problem.thoughts.map((thought) => (
            <li key={thought}>{thought}</li>
          ))}
        </ul>

        <p className={styles.resolution}>
          {problem.resolution.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </p>
      </div>
    </section>
  )
}
