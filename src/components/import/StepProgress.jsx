// Visual progress indicator across the linear part of the importer journey.
// Terminal/side states (parsing, file_error, review, rejected, complete)
// map onto the phase they belong to rather than getting their own dot.
const PHASES = [
  { key: 'upload', label: 'Upload' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'headers', label: 'Headers' },
  { key: 'mapping', label: 'Map Columns' },
  { key: 'dates', label: 'Dates' },
  { key: 'currency', label: 'Currency' },
  { key: 'preview', label: 'Preview' },
]

const STEP_TO_PHASE = {
  upload: 'upload',
  parsing: 'upload',
  file_error: 'upload',
  sheet: 'sheet',
  headers: 'headers',
  mapping: 'mapping',
  dates: 'dates',
  currency: 'currency',
  preview: 'preview',
  review: 'preview',
  rejected: 'preview',
  complete: 'preview',
}

export default function StepProgress({ step, showSheetPhase, showDatesPhase, showCurrencyPhase }) {
  const phases = PHASES.filter((p) => {
    if (p.key === 'sheet') return showSheetPhase
    if (p.key === 'dates') return showDatesPhase
    if (p.key === 'currency') return showCurrencyPhase
    return true
  })
  const activePhase = STEP_TO_PHASE[step] || 'upload'

  return (
    <nav className="import-steps" aria-label="Import progress">
      {phases.map((p, i) => (
        <div key={p.key} className={p.key === activePhase ? 'import-step active' : 'import-step'} aria-current={p.key === activePhase ? 'step' : undefined}>
          <span className="import-step-num">{i + 1}</span>
          <span>{p.label}</span>
        </div>
      ))}
    </nav>
  )
}
