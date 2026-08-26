import DwReplayShift from './DwReplayShift'
import DwCheckPanel from './DwCheckPanel'

export default function DwReplayCheckSurface({ replay, checks = [] }) {
  if (!replay && (!Array.isArray(checks) || checks.length === 0)) return null
  return (
    <section className="dw-replay-check-surface" data-dw-read-only="true">
      <DwReplayShift model={replay} />
      {Array.isArray(checks) && checks.map((check) => <DwCheckPanel key={check.runId || String(check.expectedRequired)} model={check} />)}
    </section>
  )
}
