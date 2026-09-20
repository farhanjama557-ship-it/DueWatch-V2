const focusRows = [
  { client: 'Atlas Freight', invoice: '#1049', amount: '$12,480', due: '14 days overdue', state: 'Needs review', tone: 'orange' },
  { client: 'Northstar Labs', invoice: '#1056', amount: '$8,250', due: '8 days overdue', state: 'DW handling', tone: 'green' },
  { client: 'Luma Studio', invoice: '#1062', amount: '$4,900', due: 'Due in 2 days', state: 'Scheduled', tone: 'blue' },
]

const actionRows = [
  { when: 'Today · 3:30 PM', client: 'Northstar Labs', action: 'Friendly reminder', mode: 'Autopilot' },
  { when: 'Tomorrow · 9:00 AM', client: 'Luma Studio', action: 'Promise follow-up', mode: 'Scheduled' },
  { when: 'Sep 23 · 10:00 AM', client: 'Atlas Freight', action: 'Policy review', mode: 'Needs approval' },
]

const noticed = [
  {
    title: 'Atlas — Late fee policy conflict',
    body: 'Conflicting instructions found. DW is investigating.',
    meta: 'Waiting 4m · 3 sources',
    signature: true,
  },
  {
    title: 'Payment received',
    body: 'Northstar Labs payment evidence matched the invoice.',
    meta: 'Verified · 2 sources',
  },
  {
    title: 'Promises need review',
    body: 'Two promises are approaching their follow-up window.',
    meta: '2 items',
  },
]

function TinySpark({ variant = 'up' }) {
  const d = variant === 'flat' ? 'M1 12 L7 9 L12 11 L18 7 L24 8' : 'M1 13 L6 11 L10 12 L15 6 L20 8 L25 3'
  return (
    <svg className="ov-spark" viewBox="0 0 26 16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function OrbitGlyph({ type }) {
  const shapes = {
    cash: <><path d="M6 15h12M8 12V8m4 4V5m4 7V9" /><circle cx="17.5" cy="5.5" r="2.3" /></>,
    payments: <><path d="M5 8h14v9H5z" /><path d="M5 10h14M8 14h3" /></>,
    evidence: <><path d="M7 4h9l3 3v13H7z" /><path d="M16 4v4h4M10 12h6M10 15h5" /></>,
    reminders: <><path d="M12 5a5 5 0 0 1 5 5v4l2 2H5l2-2v-4a5 5 0 0 1 5-5Z" /><path d="M10 19h4" /></>,
    memory: <><circle cx="12" cy="12" r="7" /><path d="M9 10h6M9 13h6M10 16h4" /></>,
    activity: <><path d="M4 13h4l2-5 4 9 2-4h4" /></>,
  }
  return (
    <span className={`ov-orbit-icon ov-orbit-icon--${type}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{shapes[type]}</svg>
    </span>
  )
}

function OrbitCard({ title, value, note, type, className = '' }) {
  return (
    <div className={`ov-orbit-card ${className}`}>
      <OrbitGlyph type={type} />
      <div>
        <span className="ov-orbit-label">{title}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </div>
  )
}

function PulseCore() {
  return (
    <div className="ov-pulse-stage">
      <svg className="ov-pulse-lines" viewBox="0 0 760 400" preserveAspectRatio="none" aria-hidden="true">
        <path d="M380 198 C300 170 238 120 176 76" />
        <path d="M380 198 C300 180 233 188 151 195" />
        <path d="M380 198 C305 220 238 278 166 323" />
        <path d="M380 198 C455 168 521 115 593 72" />
        <path d="M380 198 C458 190 526 194 613 195" />
        <path d="M380 198 C456 224 523 280 598 327" />
      </svg>

      <OrbitCard className="cash" type="cash" title="Cash awareness" value="$428.5k" note="under management" />
      <OrbitCard className="payments" type="payments" title="Payments" value="18 tracked" note="this month" />
      <OrbitCard className="evidence" type="evidence" title="Evidence" value="42 verified" note="sources linked" />
      <OrbitCard className="reminders" type="reminders" title="Reminders & follow-ups" value="7 queued" note="within authority" />
      <OrbitCard className="memory" type="memory" title="Client memory" value="12 active" note="patterns retained" />
      <OrbitCard className="activity" type="activity" title="Activity stream" value="31 events" note="recently recorded" />

      <div className="ov-orb-wrap" aria-label="DW Pulse resting">
        <div className="ov-orb-ring ov-orb-ring-one" />
        <div className="ov-orb-ring ov-orb-ring-two" />
        <div className="ov-orb">
          <div className="ov-orb-core" />
        </div>
        <div className="ov-orb-copy">
          <strong>DW PULSE</strong>
          <span>Monitoring. Analyzing. Taking action.</span>
        </div>
      </div>
    </div>
  )
}

function StatusChip({ children, tone = 'neutral' }) {
  return <span className={`ov-chip ov-chip--${tone}`}>{children}</span>
}

function RightRail() {
  return (
    <aside className="ov-right-rail">
      <section className="ov-panel">
        <div className="ov-panel-head">
          <div>
            <span className="ov-eyebrow">Live Monitor</span>
            <h3>System activity</h3>
          </div>
          <StatusChip tone="green">Live</StatusChip>
        </div>
        <div className="ov-monitor-grid">
          <div><span>Invoices watched</span><strong>168</strong><TinySpark /></div>
          <div><span>Evidence recorded</span><strong>42</strong><TinySpark /></div>
          <div><span>Payments tracked</span><strong>18</strong><TinySpark variant="flat" /></div>
          <div><span>Autopilot actions</span><strong>27</strong><TinySpark /></div>
        </div>
      </section>

      <section className="ov-panel">
        <div className="ov-panel-head compact">
          <div>
            <span className="ov-eyebrow">What DW noticed</span>
            <h3>Needs awareness</h3>
          </div>
          <button className="ov-text-button" type="button" aria-disabled="true">View all</button>
        </div>
        <div className="ov-notice-list">
          {noticed.map((item) => (
            <article className="ov-notice" key={item.title}>
              <div className="ov-notice-dot" />
              <div className="ov-notice-copy">
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                {item.signature && (
                  <button className="ov-signature-trigger" type="button" aria-disabled="true">
                    <span>✦</span> DW Signature <span>→</span>
                  </button>
                )}
                <small>{item.meta}</small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="ov-panel">
        <div className="ov-panel-head compact">
          <div>
            <span className="ov-eyebrow">Recent operational events</span>
            <h3>Latest</h3>
          </div>
        </div>
        <div className="ov-event-list">
          <div><span className="ov-event-dot green" /><p><strong>Northstar Labs</strong><small>Payment evidence verified · 12m ago</small></p></div>
          <div><span className="ov-event-dot orange" /><p><strong>Atlas Freight</strong><small>Policy conflict detected · 24m ago</small></p></div>
          <div><span className="ov-event-dot blue" /><p><strong>Luma Studio</strong><small>Follow-up scheduled · 41m ago</small></p></div>
        </div>
      </section>
    </aside>
  )
}

export default function LockedPulse() {
  return (
    <div className="ov-pulse-page">
      <div className="ov-topbar">
        <label className="ov-global-search">
          <span>⌕</span>
          <input placeholder="Search invoices, clients, activity…" readOnly />
          <kbd>⌘K</kbd>
        </label>
        <div className="ov-top-actions">
          <button type="button" aria-label="Notifications">◌</button>
          <div className="ov-top-avatar">FJ</div>
        </div>
      </div>

      <div className="ov-page-inner">
        <section className="ov-welcome">
          <div>
            <h1>Good morning, <span>Farhan.</span></h1>
            <div className="ov-inline-status">
              <StatusChip tone="green"><span className="ov-status-dot" />Autopilot active</StatusChip>
              <span>Sunday, September 20</span>
              <span>168 invoices watched</span>
              <span>27 handled automatically</span>
              <span>3 need approval</span>
            </div>
          </div>
          <button className="ov-mode-button" type="button" aria-disabled="true">
            <span className="ov-status-dot" /> Live mode <span>⌄</span>
          </button>
        </section>

        <section className="ov-ask">
          <div className="ov-ask-row">
            <span className="ov-ask-mark">✦</span>
            <input placeholder="Ask DW anything about your receivables…" readOnly />
            <button type="button" aria-label="Voice input" aria-disabled="true">◉</button>
            <button className="ov-send" type="button" aria-disabled="true">↑</button>
          </div>
          <div className="ov-prompt-row">
            {['What needs my attention?', 'Why did Atlas pay late?', 'Show overdue by reason', 'Draft a follow-up', 'Cash forecast'].map((prompt) => (
              <button type="button" key={prompt} aria-disabled="true">{prompt}</button>
            ))}
          </div>
        </section>

        <div className="ov-main-grid">
          <section className="ov-command">
            <PulseCore />

            <div className="ov-work-grid">
              <section className="ov-panel ov-table-panel">
                <div className="ov-panel-head">
                  <div>
                    <span className="ov-eyebrow">Top invoices to focus on</span>
                    <h3>Priority receivables</h3>
                  </div>
                  <button className="ov-text-button" type="button" aria-disabled="true">View invoices</button>
                </div>
                <div className="ov-table">
                  <div className="ov-tr ov-th"><span>Client</span><span>Invoice</span><span>Amount</span><span>Timing</span><span>Status</span></div>
                  {focusRows.map((row) => (
                    <div className="ov-tr" key={row.client}>
                      <span><b className="ov-client-avatar">{row.client.slice(0, 2).toUpperCase()}</b><strong>{row.client}</strong></span>
                      <span>{row.invoice}</span><span>{row.amount}</span><span>{row.due}</span>
                      <span><StatusChip tone={row.tone}>{row.state}</StatusChip></span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ov-panel ov-table-panel">
                <div className="ov-panel-head">
                  <div>
                    <span className="ov-eyebrow">Due soon & scheduled actions</span>
                    <h3>Upcoming</h3>
                  </div>
                  <button className="ov-text-button" type="button" aria-disabled="true">Calendar</button>
                </div>
                <div className="ov-table ov-action-table">
                  <div className="ov-tr ov-th"><span>When</span><span>Client</span><span>Action</span><span>Mode</span></div>
                  {actionRows.map((row) => (
                    <div className="ov-tr" key={row.when}>
                      <span>{row.when}</span><span><strong>{row.client}</strong></span><span>{row.action}</span><span>{row.mode}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="ov-bottom-grid">
              <section className="ov-panel ov-impact">
                <div className="ov-panel-head">
                  <div>
                    <span className="ov-eyebrow">Autopilot impact this month</span>
                    <h3>Work handled quietly</h3>
                  </div>
                </div>
                <div className="ov-impact-metrics">
                  <div><span>Actions handled</span><strong>27</strong><small>without founder input</small></div>
                  <div><span>Approvals requested</span><strong>3</strong><small>judgment preserved</small></div>
                  <div><span>Accounts watched</span><strong>42</strong><small>across 168 invoices</small></div>
                </div>
              </section>

              <section className="ov-panel ov-mode-panel">
                <div className="ov-panel-head">
                  <div>
                    <span className="ov-eyebrow">DW operating mode</span>
                    <h3>Normal</h3>
                  </div>
                  <button className="ov-text-button" type="button" aria-disabled="true">Autopilot settings</button>
                </div>
                <div className="ov-mode-options">
                  <button className="is-selected" type="button" aria-disabled="true">Normal</button>
                  <button type="button" aria-disabled="true">Night Shift</button>
                  <button type="button" aria-disabled="true">Cash Recovery</button>
                  <button type="button" aria-disabled="true">Protect</button>
                  <button type="button" aria-disabled="true">Away</button>
                  <button type="button" aria-disabled="true">Quarter-End</button>
                </div>
                <div className="ov-mode-meta">
                  <span>Timezone <strong>Local</strong></span>
                  <span>Quiet hours <strong>On</strong></span>
                  <span>Weekend actions <strong>Off</strong></span>
                </div>
              </section>
            </div>
          </section>

          <RightRail />
        </div>
      </div>
    </div>
  )
}
