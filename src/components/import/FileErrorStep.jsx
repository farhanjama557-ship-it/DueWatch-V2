import { AlertTriangle } from 'lucide-react'
import { fileErrorCopy } from '../../lib/importUiCopy.js'

export default function FileErrorStep({ error, onRetry }) {
  const copy = fileErrorCopy(error?.code)
  return (
    <div className="brief-card" role="alert">
      <div className="import-file-error">
        <AlertTriangle width={22} height={22} aria-hidden="true" />
        <h3>{copy.title}</h3>
        <p className="import-help">{copy.message}</p>
        <button className="btn-terracotta btn-inline" onClick={onRetry}>
          Try another file
        </button>
      </div>
    </div>
  )
}
