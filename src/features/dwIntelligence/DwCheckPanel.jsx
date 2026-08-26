export default function DwCheckPanel({ model }) {
  if (!model) return null
  return (
    <section className="dw-check-panel" data-dw-read-only="true" aria-label="DW Check">
      <div className="dw-replay-head">
        <div><span className="dw-command-kicker">DW Check</span><h2>Plan vs proof</h2></div>
        <strong>{model.healthy ? 'Verified' : 'Needs inspection'}</strong>
      </div>
      <dl className="dw-check-metrics">
        <div><dt>Required</dt><dd>{model.expectedRequired}</dd></div>
        <div><dt>Observed</dt><dd>{model.observedRequired}</dd></div>
        <div><dt>Silently skipped</dt><dd>{model.silentlySkipped == null ? 'Not provable' : model.silentlySkipped}</dd></div>
        <div><dt>Hard violations</dt><dd>{model.hardViolations.length}</dd></div>
      </dl>
      {model.missingRequired.length > 0 && <ul>{model.missingRequired.map(x => <li key={x.id}>{x.label}</li>)}</ul>}
    </section>
  )
}
