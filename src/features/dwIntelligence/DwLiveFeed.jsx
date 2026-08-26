export default function DwLiveFeed({ model, onJoin }) {
  if (!model || !Array.isArray(model.feed) || model.feed.length === 0) return null
  return (
    <section className="dw-live-feed" data-dw-read-only="true" aria-label="DW Live Feed">
      <div className="dw-live-feed-head">
        <strong>Live Feed</strong>
        <span>{model.activeCount > 0 ? `${model.activeCount} active` : model.waitingCount > 0 ? `${model.waitingCount} waiting` : 'Caught up'}</span>
      </div>
      <ol>
        {model.feed.slice(0, 8).map((event) => (
          <li key={event.id} className={event.realSideEffect ? 'dw-live-feed-item has-side-effect' : 'dw-live-feed-item'}>
            <span className="dw-live-feed-time">{event.at}</span>
            <span className="dw-live-feed-phase">{event.workPhase}</span>
            <span className="dw-live-feed-detail">{event.detail || event.eventType}</span>
            {event.routeTarget?.kind === 'invoice' && onJoin && (
              <button type="button" onClick={() => onJoin(event.routeTarget)}>
                Join DW
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
