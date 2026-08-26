import { presentDwLive } from '../../lib/dwIntelligence/phase2bUiPresentation'

export default function DwLiveBadge({ model }) {
  const live = presentDwLive(model)
  if (!live) return null
  return (
    <span
      className={live.active ? 'dw-live-badge is-live' : 'dw-live-badge is-caught-up'}
      aria-label={live.ariaLabel}
      data-dw-live={live.active ? 'true' : 'false'}
    >
      <span className="dw-live-dot" aria-hidden="true" />
      <span>{live.label}</span>
      <span className="dw-live-detail">{live.detail}</span>
    </span>
  )
}
