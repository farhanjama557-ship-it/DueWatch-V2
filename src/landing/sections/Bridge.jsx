import { bridge } from '../content/duewatchContent'
import styles from './Bridge.module.css'

export default function Bridge() {
  return (
    <section id="bridge" className={styles.section} aria-labelledby="bridge-heading">
      <div className={styles.opening}>
        <p className={styles.label}>{bridge.label}</p>
        <h2 id="bridge-heading" className={styles.statement}>
          {bridge.opening.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h2>

        <p className={styles.asymmetry}>
          {bridge.asymmetry.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </p>

        <p className={styles.primaryStatement}>{bridge.primaryStatement}</p>
        <p className={styles.resolution}>{bridge.resolution}</p>
      </div>

      <ul className={styles.principles}>
        {bridge.principles.map((p) => (
          <li key={p.title}>
            <h3>{p.title}</h3>
            <p>{p.body}</p>
          </li>
        ))}
      </ul>

      <div className={styles.promise}>
        {bridge.promise.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      <div className={styles.truthBoundary}>
        <div className={styles.truthBand}>
          <span className={styles.truthLabel}>{bridge.productTruth.availableLabel}</span>
          <p>{bridge.productTruth.available}</p>
        </div>
        <div className={`${styles.truthBand} ${styles.roadmapBand}`}>
          <span className={styles.truthLabel}>{bridge.productTruth.roadmapLabel}</span>
          <p>{bridge.productTruth.roadmap}</p>
        </div>
      </div>
    </section>
  )
}
