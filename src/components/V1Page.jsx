import { ChevronRight } from 'lucide-react'

export function PageHeader({ title, subtitle, actions, eyebrow }) {
  return (
    <div className="v1-page-header">
      <div>
        {eyebrow && <div className="v1-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="v1-page-actions">{actions}</div>}
    </div>
  )
}

export function SegmentedTabs({ items, value, onChange, className = '' }) {
  return (
    <div className={`v1-segmented ${className}`.trim()} role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={value === item.key ? 'active' : ''}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count != null && <span className="v1-tab-count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function SectionCard({ title, action, children, className = '' }) {
  return (
    <section className={`v1-card ${className}`.trim()}>
      {(title || action) && (
        <div className="v1-card-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="v1-empty-state">
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action}
    </div>
  )
}

export function DetailTabs({ items, value, onChange }) {
  return (
    <div className="v1-detail-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          className={value === item.key ? 'active' : ''}
          aria-selected={value === item.key}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function StatusBadge({ tone = 'neutral', children }) {
  return <span className={`v1-badge tone-${tone}`}>{children}</span>
}

export function InlineLink({ children, onClick }) {
  return (
    <button type="button" className="v1-inline-link" onClick={onClick}>
      {children}<ChevronRight size={14} />
    </button>
  )
}
