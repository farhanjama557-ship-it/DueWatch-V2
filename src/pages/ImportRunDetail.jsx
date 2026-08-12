import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  continueImportRunToCompletion,
  getImportRunDetail,
  requestImportCancellation,
} from '../lib/importPersistence/importPersistenceClient.js'
import {
  formatRunCounts,
  isTerminalRunStatus,
  presentBlockReason,
  presentImportEvent,
  presentRowProvenance,
  presentRunStatus,
} from '../lib/importPersistence/importPresentation.js'

function formatTimestamp(value) {
  if (!value) return 'Not recorded'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function RowSummary({ row }) {
  const payload = row.material_payload || {}
  const provenance = presentRowProvenance(row)
  const reason = row.server_status === 'blocked' ? presentBlockReason(row.block_reason_code) : null

  return (
    <li className="import-detail-row">
      <div className="import-detail-row-head">
        <strong>Row {row.row_number}</strong>
        <span className={`import-row-status import-row-status--${row.server_status}`}>{row.server_status}</span>
      </div>
      <p>{payload.invoice_number || 'Invoice number not available'}{payload.client_name ? ` - ${payload.client_name}` : ''}</p>
      {provenance && (
        <div className="import-provenance">
          <span>{provenance.client}{provenance.clientId ? ` (${provenance.clientId})` : ''}</span>
          <span>{provenance.invoice}{provenance.invoiceId ? ` (${provenance.invoiceId})` : ''}</span>
          {provenance.clientUnavailable && <span>The linked client is no longer available.</span>}
          {provenance.invoiceUnavailable && <span>The linked invoice is no longer available.</span>}
          <span>Saved {formatTimestamp(row.committed_at)}</span>
        </div>
      )}
      {reason && (
        <div className="import-block-reason">
          <strong>{reason.title}</strong>
          <span>{reason.explanation}</span>
          <span>{reason.action}</span>
          {reason.kind === 'unknown' && <code>{reason.technicalDetail}</code>}
        </div>
      )}
      {row.server_status === 'pending' && <p className="import-detail-note">This row has not been processed yet.</p>}
      {row.server_status === 'failed' && <p className="import-detail-note">This row did not finish. No saved result is claimed.</p>}
    </li>
  )
}

export default function ImportRunDetail() {
  const { runId } = useParams()
  const { user } = useAuth()
  const activeRef = useRef(true)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState('idle')
  const [error, setError] = useState(null)

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!user?.id || !runId) return
    setError(null)
    try {
      const next = await getImportRunDetail({ userId: user.id, runId })
      if (activeRef.current) setDetail(next)
    } catch {
      if (activeRef.current) setError('Import run not found.')
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [runId, user?.id])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  async function handleResume() {
    setAction('resuming')
    setError(null)
    try {
      await continueImportRunToCompletion({
        userId: user.id,
        runId,
        shouldContinue: () => activeRef.current,
        onProgress: (progress) => {
          if (activeRef.current) {
            setDetail((current) => current ? { ...current, progress, run: { ...current.run, status: progress.status } } : current)
          }
        },
      })
      if (activeRef.current) await load()
    } catch {
      if (activeRef.current) setError('Duewatch could not continue this import. No unverified result is being shown.')
    } finally {
      if (activeRef.current) setAction('idle')
    }
  }

  async function handleRequestCancellation() {
    setAction('cancelling')
    setError(null)
    try {
      await requestImportCancellation(runId)
      if (activeRef.current) await load()
    } catch {
      if (activeRef.current) setError('Cancellation could not be requested.')
    } finally {
      if (activeRef.current) setAction('idle')
    }
  }

  const status = detail ? presentRunStatus(detail.run.status) : null
  const counts = detail ? formatRunCounts({ status: detail.run.status, ...detail.progress }) : null
  // A nonterminal run with zero currently visible pending rows can still
  // need one server call to close a requested cancellation or settle its
  // durable terminal status. The server remains the lifecycle authority.
  const canContinue = detail && !isTerminalRunStatus(detail.run.status)
  const events = detail?.events || []
  const lastBatchFailure = detail?.batches ? [...detail.batches].reverse().find((batch) => batch.status === 'failed') : null

  return (
    <div className="brief import-history-shell">
      <div className="list-head">
        <div>
          <Link to="/imports" className="import-back-link">Import history</Link>
          <h1 className="brief-greeting">Import details</h1>
        </div>
        <Link to="/import" className="btn-outline btn-inline">New import</Link>
      </div>

      {loading ? <p className="brief-empty" role="status">Loading import details...</p> : error && !detail ? <p className="brief-error" role="alert">{error}</p> : detail && (
        <>
          <section className="brief-card import-run-summary" aria-label={`Import status: ${status.label}`}>
            <div>
              <span className={`import-run-status import-run-status--${detail.run.status}`}>{status.label}</span>
              <p>{status.description}</p>
              <p className="import-detail-note">Created {formatTimestamp(detail.run.created_at)}</p>
            </div>
            <div className="import-history-counts import-detail-counts">
              <span>{counts.saved}</span><span>{counts.blocked}</span><span>{counts.pending}</span>
            </div>
            {detail.progress.cancelRequested && !status.terminal && <p className="import-cancellation-note">Cancellation requested. Finish cancellation to let the server close this run safely.</p>}
            {lastBatchFailure && <p className="brief-error">{lastBatchFailure.failure_reason || 'A batch stopped safely. No raw database diagnostic is shown.'}</p>}
            {error && <p className="brief-error" role="alert">{error}</p>}
            {canContinue && (
              <div className="import-detail-actions">
                <button className="btn-terracotta btn-inline" disabled={action !== 'idle'} onClick={handleResume}>
                  {detail.progress.cancelRequested ? 'Finish cancellation' : action === 'resuming' ? 'Continuing...' : 'Continue import'}
                </button>
                {!detail.progress.cancelRequested && (
                  <button className="btn-outline btn-inline" disabled={action !== 'idle'} onClick={handleRequestCancellation}>
                    {action === 'cancelling' ? 'Requesting...' : 'Cancel import'}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="brief-card import-detail-section">
            <h2>Rows</h2>
            {detail.rows.length === 0 ? <p className="brief-empty">No persisted rows were found.</p> : <ol className="import-detail-rows">{detail.rows.map((row) => <RowSummary key={row.id} row={row} />)}</ol>}
          </section>

          <section className="brief-card import-detail-section">
            <h2>Activity</h2>
            <p className="import-detail-note">Activity records chronology only. The status above comes from the import run itself.</p>
            {events.length === 0 ? <p className="brief-empty">No activity has been recorded.</p> : (
              <ol className="import-event-list">
                {events.map((event) => {
                  const item = presentImportEvent(event)
                  return <li key={event.id}><strong>{item.label}</strong><span>{formatTimestamp(item.createdAt)}</span></li>
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}
