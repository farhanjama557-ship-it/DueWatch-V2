import { useMemo, useState } from 'react'
import {
  REVIEW_SURFACE_STATE,
  REVIEW_TAB,
  buildFounderReviewView,
} from '../../lib/companyBrain/founderReviewPresentation'
import './companyBrainReview.css'

/**
 * M2G-G6 founder review surface.
 *
 * Read-and-decide only. Every control on this page either records a founder
 * review decision (which never grants DW anything) or hands off to the exact
 * G5 authority path. The component performs no authority evaluation, no
 * accounts-receivable execution and no canonical financial write, and it never
 * bundles "approve understanding" with "grant authority".
 */

function StatusBadge({ label, tone }) {
  // Status is carried by text, not by colour alone.
  return (
    <span className={`cb-status cb-status-${tone}`}>
      <span className="cb-status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

function toneFor(status) {
  if (status === 'APPROVED' || status === 'EDITED') return 'confirmed'
  if (status === 'REJECTED') return 'rejected'
  if (status === 'HELD' || status === 'DEFERRED') return 'paused'
  return 'attention'
}

function EvidenceList({ evidence }) {
  if (!evidence?.length) {
    return <p className="cb-evidence-empty">No source evidence is recorded for this item.</p>
  }
  return (
    <ul className="cb-evidence">
      {evidence.map((entry) => (
        <li key={entry.sourceVersionId} className={entry.presentedAsCurrentEvidence ? '' : 'cb-evidence-stale'}>
          <span className="cb-evidence-type">{entry.sourceType || 'Source'}</span>
          <span className="cb-evidence-id">{entry.sourceVersionId}</span>
          <span className="cb-evidence-state">{entry.state}</span>
          {entry.recordedAt && <span className="cb-evidence-time">{entry.recordedAt}</span>}
        </li>
      ))}
    </ul>
  )
}

function ConflictSides({ positions, currentResult }) {
  if (!positions?.length) return null
  return (
    <div className="cb-conflict">
      <h4>Every side of this conflict</h4>
      <ul className="cb-conflict-sides">
        {positions.map((position) => (
          <li key={position.claimId}>
            <strong>{position.scopeLabel}</strong>
            <span>{position.value}</span>
          </li>
        ))}
      </ul>
      <p className="cb-conflict-result">Current result: {currentResult}</p>
      <p className="cb-conflict-note">
        Deciding which evidence governs does not give DW permission to act on it.
      </p>
    </div>
  )
}

function ReviewCard({ card, onReviewAction, busyKey }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const busy = busyKey === card.reviewKey

  function submit(action) {
    onReviewAction?.({
      reviewKey: card.reviewKey,
      action,
      expectedRevision: card.expectedRevision,
      subjectFingerprint: card.subjectFingerprint,
      reviewedValue: action === 'EDIT' ? draft : undefined,
    })
    if (action === 'EDIT') setEditing(false)
  }

  return (
    <article className="cb-card" aria-labelledby={`cb-title-${card.reviewKey}`}>
      <header className="cb-card-head">
        <div>
          <h3 id={`cb-title-${card.reviewKey}`}>{card.title}</h3>
          <p className="cb-card-scope">{card.scopeLabel}</p>
        </div>
        <StatusBadge label={card.statusLabel} tone={toneFor(card.status)} />
      </header>

      <dl className="cb-card-body">
        <dt>What DW believes</dt>
        <dd>{card.belief}</dd>
        <dt>Why</dt>
        <dd>{card.why}</dd>
        {card.confidence != null && (
          <>
            <dt>Confidence</dt>
            <dd>
              {card.confidence}
              <span className="cb-note"> — confidence never creates permission.</span>
            </dd>
          </>
        )}
      </dl>

      {card.reviewRequiredLabel && <p className="cb-card-alert">{card.reviewRequiredLabel}</p>}

      <ConflictSides positions={card.competingPositions} currentResult={card.currentResult} />

      <details className="cb-card-evidence">
        <summary>Evidence ({card.evidence.length})</summary>
        <EvidenceList evidence={card.evidence} />
      </details>

      {card.actions.length > 0 ? (
        <div className="cb-card-actions">
          <h4 className="cb-actions-title">Your review</h4>
          <div className="cb-actions-row">
            {card.actions.map((action) => (
              action.action === 'EDIT' ? (
                <button
                  key={action.action}
                  type="button"
                  className="cb-btn"
                  disabled={busy}
                  onClick={() => setEditing((open) => !open)}
                >
                  {action.label}
                </button>
              ) : (
                <button
                  key={action.action}
                  type="button"
                  className="cb-btn"
                  disabled={busy}
                  onClick={() => submit(action.action)}
                >
                  {action.label}
                </button>
              )
            ))}
          </div>
          {editing && (
            <div className="cb-edit">
              <label htmlFor={`cb-edit-${card.reviewKey}`}>Your correction</label>
              <input
                id={`cb-edit-${card.reviewKey}`}
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="button" className="cb-btn" disabled={busy || !draft.trim()} onClick={() => submit('EDIT')}>
                Save correction
              </button>
            </div>
          )}
          <p className="cb-authority-note">{card.authorityNote}</p>
        </div>
      ) : (
        <p className="cb-authority-note">
          This is shown for review only. It is changed through the DW authority section.
        </p>
      )}
    </article>
  )
}

function AuthorityDimensions({ dimensions }) {
  return (
    <dl className="cb-dimensions">
      {dimensions.map((entry) => (
        <div key={entry.dimension} className="cb-dimension">
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function AuthorityPanel({ authority, onGrantAuthority, onRevokeAuthority }) {
  return (
    <section className="cb-authority" aria-label="DW authority">
      <h2>What DW is allowed to do</h2>
      <p className="cb-authority-lead">
        Approving what DW understood is a separate decision from giving DW permission to act.
        Permission exists only where you granted it explicitly below.
      </p>

      {authority.noStandingAuthority && (
        <p className="cb-empty">{authority.noStandingAuthorityLabel}</p>
      )}

      {authority.grants.map((grant) => (
        <article key={grant.grantId} className="cb-card cb-card-authority">
          <header className="cb-card-head">
            <h3>{grant.title}</h3>
            <StatusBadge label={grant.statusLabel} tone="confirmed" />
          </header>
          <AuthorityDimensions dimensions={grant.dimensions} />
          <button type="button" className="cb-btn cb-btn-danger" onClick={() => onRevokeAuthority?.(grant.grantId)}>
            {grant.revokeLabel}
          </button>
        </article>
      ))}

      {authority.proposals.map((proposal) => (
        <article key={proposal.proposalId} className="cb-card cb-card-proposal">
          <header className="cb-card-head">
            <h3>DW proposes: {proposal.title}</h3>
            <StatusBadge label={proposal.inertLabel} tone="attention" />
          </header>
          <AuthorityDimensions dimensions={proposal.dimensions} />
          <div className="cb-actions-row">
            {/* Never pre-selected, never bundled with an understanding approval. */}
            <button type="button" className="cb-btn cb-btn-primary" onClick={() => onGrantAuthority?.(proposal.proposalId)}>
              {proposal.grantLabel}
            </button>
            <button type="button" className="cb-btn">{proposal.editLabel}</button>
            <button type="button" className="cb-btn">{proposal.rejectLabel}</button>
            <button type="button" className="cb-btn">{proposal.holdLabel}</button>
          </div>
        </article>
      ))}

      {authority.revoked.length > 0 && (
        <div className="cb-revoked">
          <h3>Revoked authority (kept as history)</h3>
          <ul>
            {authority.revoked.map((entry) => (
              <li key={entry.grantId}>
                {entry.title} · {entry.statusLabel}
                {entry.revokedAt ? ` · ${entry.revokedAt}` : ''}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function HistoryList({ entries }) {
  if (!entries.length) return <p className="cb-empty">You have not made any review decisions yet.</p>
  return (
    <ol className="cb-history">
      {entries.map((entry) => (
        <li key={entry.revisionId}>
          <span className="cb-history-action">{entry.actionLabel}</span>
          <span className="cb-history-status">{entry.statusLabel}</span>
          <span className="cb-history-rev">Revision {entry.revision}</span>
          <span className="cb-history-time">{entry.decidedAt}</span>
          {entry.reason && <span className="cb-history-reason">{entry.reason}</span>}
        </li>
      ))}
    </ol>
  )
}

export default function CompanyBrainReview({
  readModel = null,
  loading = false,
  error = null,
  onReviewAction,
  onGrantAuthority,
  onRevokeAuthority,
  busyKey = null,
}) {
  const view = useMemo(
    () => buildFounderReviewView({ readModel, loading, error }),
    [readModel, loading, error],
  )
  const [tab, setTab] = useState(REVIEW_TAB.OVERVIEW)

  if (view.surfaceState === REVIEW_SURFACE_STATE.LOADING) {
    return <div className="cb-page" role="status" aria-live="polite">{view.message}</div>
  }
  if (view.surfaceState === REVIEW_SURFACE_STATE.ERROR) {
    return <div className="cb-page cb-page-error" role="alert">{view.message}</div>
  }
  if (view.surfaceState === REVIEW_SURFACE_STATE.EMPTY) {
    return <div className="cb-page cb-empty">{view.message}</div>
  }

  const cards = view.sections[tab] || []

  return (
    <div className="cb-page">
      <header className="cb-page-head">
        <h1>What DW learned about your company</h1>
        <p className="cb-page-sub">
          Review it like you would an employee&rsquo;s notes. Confirming what DW understood is not the
          same as authorising DW to act.
        </p>
        <div className="cb-readiness">
          <p>{view.readiness.understandingStatement}</p>
          <p>{view.readiness.authorityStatement}</p>
        </div>
      </header>

      <dl className="cb-summary">
        <div><dt>Needs you</dt><dd>{view.summary.needsReview}</dd></div>
        <div><dt>Understanding reviewed</dt><dd>{view.summary.understandingReviewed}</dd></div>
        <div><dt>Conflicts unresolved</dt><dd>{view.summary.conflictsUnresolved}</dd></div>
        <div><dt>Authority proposals</dt><dd>{view.summary.authorityProposals}</dd></div>
        <div><dt>Active authority grants</dt><dd>{view.summary.activeAuthorityGrants}</dd></div>
        <div><dt>Changed since your review</dt><dd>{view.summary.changedSinceReview}</dd></div>
      </dl>

      <nav className="cb-tabs" aria-label="Company Brain review sections">
        {view.tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === tab ? 'cb-tab active' : 'cb-tab'}
            aria-current={entry.id === tab ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label} <span className="cb-tab-count">{entry.count}</span>
          </button>
        ))}
      </nav>

      {tab === REVIEW_TAB.AUTHORITY ? (
        <AuthorityPanel
          authority={view.authority}
          onGrantAuthority={onGrantAuthority}
          onRevokeAuthority={onRevokeAuthority}
        />
      ) : tab === REVIEW_TAB.HISTORY ? (
        <HistoryList entries={view.sections[REVIEW_TAB.HISTORY]} />
      ) : cards.length === 0 ? (
        <p className="cb-empty">Nothing here needs you right now.</p>
      ) : (
        <div className="cb-cards">
          {cards.map((card) => (
            <ReviewCard key={card.reviewKey} card={card} onReviewAction={onReviewAction} busyKey={busyKey} />
          ))}
        </div>
      )}
    </div>
  )
}
