import { Bot } from 'lucide-react'
import { meetDuewatch } from '../content/duewatchContent'
import { meetDuewatchDemo } from '../content/demoData'
import ProductWindow from '../ui/ProductWindow'
import styles from './MeetDuewatch.module.css'

/**
 * Static Phase 1 placeholder for the guided cinematic sequence.
 *
 * Locked framing (do not build motion against anything else): one stable,
 * centered 16:9 product window, full frame visible throughout, no tight
 * crops, no panning between disconnected areas. This component renders
 * that single fixed frame with one representative snapshot of the
 * workflow (invoice open, draft ready, JourneyBar mid-lifecycle) — the
 * guided pointer, the phrase-by-phrase reveal, the Cognitive rings, and
 * the Living Work Trace are Phase 2+ and are deliberately not mocked here
 * so Phase 2 isn't built against a fake motion reference.
 */
export default function MeetDuewatch() {
  return (
    <section id="employee-moment" className={styles.section} aria-labelledby="meet-duewatch-heading">
      <p className={styles.label}>{meetDuewatch.label}</p>
      <h2 id="meet-duewatch-heading" className={styles.title}>
        {meetDuewatch.title}
      </h2>
      <p className={styles.supportingLine}>{meetDuewatch.supportingLine}</p>
      <p className={styles.principle}>{meetDuewatch.principle}</p>
      <p className={styles.aiMention}>{meetDuewatch.aiMention}</p>

      <div className={styles.stage}>
        <ProductWindow label={meetDuewatch.demoLabel} wide>
          <div className={styles.demo}>
            <div className={styles.demoTop}>
              <span className={styles.botMark} aria-hidden="true">
                <Bot size={18} />
              </span>
              <div>
                <p className={styles.demoClient}>{meetDuewatchDemo.client}</p>
                <p className={styles.demoInvoice}>
                  {meetDuewatchDemo.invoiceNumber} · {meetDuewatchDemo.amount} · {meetDuewatchDemo.status}
                </p>
              </div>
            </div>

            <pre className={styles.draft}>{meetDuewatchDemo.draft}</pre>

            <div className={styles.demoActions}>
              <button type="button" className={styles.approveBtn}>
                Approve &amp; Send
              </button>
              <button type="button" className={styles.secondaryBtn}>
                Edit First
              </button>
              <button type="button" className={styles.ghostBtn}>
                Skip
              </button>
            </div>

            <ol className={styles.journeyBar} aria-label="Reminder lifecycle">
              {meetDuewatch.journeyBar.map((stage, i) => (
                <li key={stage} className={i <= 1 ? styles.journeyDone : styles.journeyPending}>
                  {stage}
                </li>
              ))}
            </ol>
          </div>
        </ProductWindow>

        <div className={styles.morningBrief}>
          <p className={styles.mbGreeting}>{meetDuewatch.morningBrief.greeting}</p>
          {meetDuewatch.morningBrief.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className={styles.mbClosing}>{meetDuewatch.morningBrief.closing}</p>
        </div>
      </div>

      <ul className={styles.labels} aria-label="Product labels shown in this demonstration">
        {meetDuewatch.labels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>

      <div className={styles.controls}>
        <button type="button" className={styles.controlBtn}>
          {meetDuewatch.replayLabel}
        </button>
        <a className={styles.controlBtn} href="#presence">
          {meetDuewatch.exploreLabel}
        </a>
      </div>
    </section>
  )
}
