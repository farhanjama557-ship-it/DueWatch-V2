export default function DwReplayShift({ model }) {
  if (!model || !Array.isArray(model.runs) || model.runs.length === 0) return null
  return (
    <section className="dw-replay-shift" data-dw-read-only="true" aria-label="DW Replay Shift">
      <div className="dw-replay-head">
        <div>
          <span className="dw-command-kicker">Replay Shift</span>
          <h2>What DW actually did</h2>
        </div>
        <span>{model.completedRuns} completed · {model.openRuns} open</span>
      </div>
      {model.runs.map((run) => (
        <article key={run.runId} className="dw-replay-run">
          <div className="dw-replay-run-head">
            <strong>{run.invoiceId || run.runId}</strong>
            <span>{run.completed ? run.terminalEvent : 'Still running'}</span>
          </div>
          <ol>
            {run.timeline.map((step) => (
              <li key={`${run.runId}-${step.sequence}`}>
                <span>{step.workPhase}</span>
                <small>{step.at}</small>
                {step.detail && <p>{step.detail}</p>}
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  )
}
