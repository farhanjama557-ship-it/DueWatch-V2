import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { listImportRuns } from '../lib/importPersistence/importPersistenceClient.js'
import { formatRunCounts, presentRunStatus } from '../lib/importPersistence/importPresentation.js'

const PAGE_SIZE = 20

function formatTimestamp(value) {
  if (!value) return 'Time not recorded'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function ImportHistory() {
  const { user } = useAuth()
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user?.id) return undefined
    let active = true
    setLoading(true)
    setError(null)
    listImportRuns({ userId: user.id, page, pageSize: PAGE_SIZE })
      .then((data) => {
        if (active) setRuns(data)
      })
      .catch(() => {
        if (active) setError('Import history could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [page, user?.id])

  return (
    <div className="brief import-history-shell">
      <div className="list-head">
        <div>
          <h1 className="brief-greeting">Import history</h1>
          <p className="brief-subline">Durable results from invoice imports.</p>
        </div>
        <Link to="/import" className="btn-terracotta btn-inline">New import</Link>
      </div>

      <div className="brief-card import-history-card">
        {loading ? (
          <p className="brief-empty list-pad" role="status">Loading import history...</p>
        ) : error ? (
          <p className="brief-error list-pad" role="alert">{error}</p>
        ) : runs.length === 0 ? (
          <div className="import-history-empty">
            <h2>No imports yet</h2>
            <p>Completed and interrupted imports will appear here after you explicitly start one.</p>
            <Link to="/import" className="btn-outline btn-inline">Preview a file</Link>
          </div>
        ) : (
          <ul className="import-history-list">
            {runs.map((run) => {
              const status = presentRunStatus(run.status)
              const counts = formatRunCounts(run)
              return (
                <li key={run.id}>
                  <Link to={`/imports/${run.id}`} className="import-history-row" aria-label={`Import from ${formatTimestamp(run.created_at)}: ${status.label}`}>
                    <span className="import-history-main">
                      <strong>{formatTimestamp(run.created_at)}</strong>
                      <span>{run.total_rows} rows read</span>
                    </span>
                    <span className={`import-run-status import-run-status--${run.status}`}>{status.label}</span>
                    <span className="import-history-counts">
                      <span>{counts.saved}</span>
                      <span>{counts.blocked}</span>
                      <span>{counts.pending}</span>
                    </span>
                    {run.cancel_requested_at && !status.terminal && <span className="import-history-note">Cancellation requested</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {!loading && !error && (page > 0 || runs.length === PAGE_SIZE) && (
        <nav className="import-history-pagination" aria-label="Import history pages">
          <button className="btn-outline btn-inline" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
          <span>Page {page + 1}</span>
          <button className="btn-outline btn-inline" disabled={runs.length < PAGE_SIZE} onClick={() => setPage((value) => value + 1)}>Next</button>
        </nav>
      )}
    </div>
  )
}
