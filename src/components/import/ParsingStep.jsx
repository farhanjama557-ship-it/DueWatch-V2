import { Loader2 } from 'lucide-react'

// Calm, indeterminate parsing state — deliberately no percentage, no
// incremental row count, no fake progress. Real counts only ever appear
// once parsing has actually finished.
export default function ParsingStep() {
  return (
    <div className="import-dropzone" aria-live="polite">
      <Loader2 className="import-dropzone-icon spin" aria-hidden="true" />
      <p className="import-dropzone-title">Reading your file…</p>
    </div>
  )
}
