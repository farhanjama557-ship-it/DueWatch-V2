import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { header } from '../content/duewatchContent'
import styles from './SiteHeader.module.css'

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a className={styles.wordmark} href="#top">
          {header.wordmark}
        </a>

        <nav className={styles.nav} aria-label="Primary">
          {header.nav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <a className={styles.cta} href={header.primaryAction.href}>
          {header.primaryAction.label}
        </a>

        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="landing-mobile-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {menuOpen && (
        <nav id="landing-mobile-nav" className={styles.mobileNav} aria-label="Primary">
          {header.nav.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
              {item.label}
            </a>
          ))}
          <a className={styles.mobileCta} href={header.primaryAction.href} onClick={() => setMenuOpen(false)}>
            {header.primaryAction.label}
          </a>
        </nav>
      )}
    </header>
  )
}
