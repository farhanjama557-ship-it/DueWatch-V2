import { footer } from '../content/duewatchContent'
import styles from './SiteFooter.module.css'

// Privacy/Terms links are omitted until real destinations exist, per spec.
export default function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          {footer.brandLine.map((line, i) => (
            <p key={line} className={i === 0 ? styles.brandName : styles.brandTagline}>
              {line}
            </p>
          ))}
        </div>
        <nav className={styles.links} aria-label="Footer">
          {footer.links.map((label) => (
            <a key={label} href={label === 'Principles' ? '#bridge' : '#pricing'}>
              {label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  )
}
