import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData, isOutstanding } from '../context/DataContext'
import {
  DEFAULT_RULES,
  ruleTiming,
  fetchAutopilotRules,
  enableAutopilot,
  disableAutopilot,
  toggleRule,
} from '../lib/autopilot'
import { SparkleIcon, CheckIcon } from '../components/icons'

function Benefit({ text }) {
  return (
    <li className="benefit-item">
      <span className="benefit-check">
        <CheckIcon width={13} height={13} />
      </span>
      {text}
    </li>
  )
}

function Switch({ checked, onChange, label }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-slider" />
      {label && <span className="switch-label">{label}</span>}
    </label>
  )
}

export default function Autopilot() {
  const { user } = useAuth()
  const { invoices, autopilotEnabled, setAutopilotEnabledLocal, refresh } = useData()

  const [step, setStep] = useState(1) // 1 pitch, 2 rules, 3 approval, 'success'
  const [rules, setRules] = useState(DEFAULT_RULES)
  const [approvalRequired, setApprovalRequired] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Management view (already enabled): load the real saved rules.
  const [savedRules, setSavedRules] = useState([])
  const [loadingSaved, setLoadingSaved] = useState(autopilotEnabled)

  useEffect(() => {
    if (!autopilotEnabled || !user) return
    let cancelled = false
    setLoadingSaved(true)
    fetchAutopilotRules(user.id).then((r) => {
      if (!cancelled) {
        setSavedRules(r)
        setLoadingSaved(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [autopilotEnabled, user])

  const watchingCount = invoices.filter(isOutstanding).length

  function toggleDraftRule(index) {
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)))
  }

  async function handleEnable() {
    setSaving(true)
    setError('')
    const { error: err } = await enableAutopilot(user.id, { approvalRequired, rules })
    setSaving(false)
    if (err) return setError(err.message)
    setAutopilotEnabledLocal(true)
    setStep('success')
    refresh()
  }

  async function handleToggleSavedRule(rule) {
    setSavedRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)))
    await toggleRule(rule.id, !rule.enabled)
  }

  async function handleDisable() {
    setSaving(true)
    await disableAutopilot(user.id)
    setSaving(false)
    setAutopilotEnabledLocal(false)
    refresh()
  }

  // ---------- Already-enabled management view ----------
  if (autopilotEnabled) {
    return (
      <div className="brief autopilot-page">
        <div className="autopilot-success">
          <span className="success-check">
            <CheckIcon width={22} height={22} />
          </span>
          <h1 className="autopilot-success-title">Autopilot is on</h1>
          <p className="autopilot-success-sub">
            Duewatch is now watching {watchingCount} {watchingCount === 1 ? 'invoice' : 'invoices'}.
          </p>
        </div>

        <div className="brief-card">
          <div className="section-head">
            <h2 className="section-title">Rules</h2>
          </div>
          {loadingSaved ? (
            <p className="brief-empty">Loading…</p>
          ) : (
            <ul className="rule-list">
              {savedRules.map((r) => (
                <li key={r.id} className="rule-row">
                  <div className="rule-main">
                    <span className="rule-name">{r.name}</span>
                    <span className="rule-timing">{ruleTiming(r)}</span>
                  </div>
                  <Switch checked={r.enabled} onChange={() => handleToggleSavedRule(r)} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="autopilot-footer-actions">
          <Link to="/" className="btn-terracotta btn-inline">
            Back to Morning Brief
          </Link>
          <button className="btn-outline btn-inline" onClick={handleDisable} disabled={saving}>
            {saving ? 'Turning off…' : 'Turn off Autopilot'}
          </button>
        </div>
      </div>
    )
  }

  // ---------- Success state (just finished setup) ----------
  if (step === 'success') {
    return (
      <div className="brief autopilot-page">
        <div className="autopilot-success">
          <span className="success-check">
            <CheckIcon width={22} height={22} />
          </span>
          <h1 className="autopilot-success-title">Autopilot is on</h1>
          <p className="autopilot-success-sub">
            Duewatch is now watching {watchingCount} {watchingCount === 1 ? 'invoice' : 'invoices'}.
          </p>
          <Link to="/" className="btn-terracotta btn-inline">
            Back to Morning Brief
          </Link>
        </div>
      </div>
    )
  }

  // ---------- Step 1: Pitch ----------
  if (step === 1) {
    return (
      <div className="brief autopilot-page">
        <div className="autopilot-pitch">
          <span className="autopilot-pitch-icon">
            <SparkleIcon width={22} height={22} />
          </span>
          <h1 className="autopilot-headline">Let Duewatch handle the follow-ups</h1>
          <p className="autopilot-subhead">
            Autopilot sends reminders at the right time, with the right tone. You stay in control.
          </p>
          <ul className="benefit-list">
            <Benefit text="Never miss a follow-up" />
            <Benefit text="Personalized for each client" />
            <Benefit text="You approve every action, or let it run" />
          </ul>
          <button className="btn-terracotta btn-inline" onClick={() => setStep(2)}>
            Set up Autopilot
          </button>
        </div>
      </div>
    )
  }

  // ---------- Step 2: Rules ----------
  if (step === 2) {
    return (
      <div className="brief autopilot-page">
        <div className="wizard-step-label">Step 2 of 3</div>
        <h1 className="autopilot-headline">Choose your reminder rules</h1>
        <p className="autopilot-subhead">
          These run automatically once Autopilot is on. Turn any of them off if they don&apos;t fit.
        </p>

        <ul className="rule-list">
          {rules.map((r, i) => (
            <li key={r.name} className="rule-row">
              <div className="rule-main">
                <span className="rule-name">{r.name}</span>
                <span className="rule-timing">{ruleTiming(r)}</span>
              </div>
              <Switch checked={r.enabled} onChange={() => toggleDraftRule(i)} />
            </li>
          ))}
        </ul>

        <button className="btn-terracotta btn-inline" onClick={() => setStep(3)}>
          Continue
        </button>
      </div>
    )
  }

  // ---------- Step 3: Approval preference ----------
  return (
    <div className="brief autopilot-page">
      <div className="wizard-step-label">Step 3 of 3</div>
      <h1 className="autopilot-headline">How should Autopilot run?</h1>
      <p className="autopilot-subhead">You can change this any time.</p>

      {error && <div className="auth-error">{error}</div>}

      <div className="option-cards">
        <button
          type="button"
          className={approvalRequired ? 'option-card selected' : 'option-card'}
          onClick={() => setApprovalRequired(true)}
        >
          <span className="option-card-title">Review each reminder</span>
          <span className="option-card-sub">Duewatch drafts, you approve before sending.</span>
        </button>
        <button
          type="button"
          className={!approvalRequired ? 'option-card selected' : 'option-card'}
          onClick={() => setApprovalRequired(false)}
        >
          <span className="option-card-title">Let Autopilot run</span>
          <span className="option-card-sub">Sends automatically — you see everything in Activity.</span>
        </button>
      </div>

      <button className="btn-terracotta btn-inline" onClick={handleEnable} disabled={saving}>
        {saving ? 'Enabling…' : 'Enable Autopilot'}
      </button>
    </div>
  )
}
