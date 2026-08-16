import React, { useLayoutEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { createPortal } from 'react-dom'
import { BrowserRouter } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  FileText,
  Mail,
  MessageCircle,
  Search,
  Settings,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import '../src/index.css'
import '../src/styles/presence.css'
import '../src/styles/presence-reduced-motion.css'
import './exact-target.css'
import Sidebar from '../src/components/Sidebar.jsx'
import Dashboard from '../src/pages/Dashboard.jsx'
import { PresenceProvider } from '../src/features/PresenceSystem.jsx'
import { LogoMark, PulseIcon } from '../src/components/icons.jsx'
import assistantMascot from '../src/assets/duewatch-assistant.png'

const exactMode = new URLSearchParams(window.location.search).get('fixture') === 'exact'

const kpis = [
  { label: 'Collected this month', value: '$68,400', trend: '↑ 22% vs last month', tone: 'green', Icon: CircleDollarSign },
  { label: 'Outstanding', value: '$24,600', trend: '↓ 8% vs last month', tone: 'orange', Icon: TrendingUp },
  { label: 'Collection rate', value: '81%', trend: '↑ 6% vs last month', tone: 'green', Icon: BarChart3 },
  { label: 'Avg. days to pay', value: '14 days', trend: '↓ 4 days vs last month', tone: 'green', Icon: Clock3 },
  { label: 'Autopilot handled', value: '$19,200', trend: '↑ 32% vs last month', tone: 'green', Icon: Bot },
  { label: 'Reminders sent', value: '34', trend: '↑ 9 vs last month', tone: 'violet', Icon: Mail },
]

const approvals = [
  ['Payment plan request', 'Atlas Creative — INV-1040', '$1,800'],
  ['Dispute response', 'Marlow Media — INV-1027', '$2,200'],
  ['Write-off recommendation', 'Summit Studios — INV-0981', '$950'],
]

const scheduled = [
  ['Send reminder', 'INV-1071 · Marlow Media', 'May 18 · 9:00 AM'],
  ['Send reminder', 'INV-1083 · Atlas Creative', 'May 18 · 2:00 PM'],
  ['Follow up', 'INV-1062 · Riverbend Co.', 'May 19 · 10:00 AM'],
]

const evidence = [
  ['Reminder sent', 'Cedar Analytics · INV-1048', '2m ago', Mail],
  ['Client replied', 'Bluepeak LLC · INV-1032', '18m ago', MessageCircle],
  ['Payment recorded', 'Atlas Creative · INV-1010', '1h ago', Check],
]

function ExactKpis() {
  return kpis.map(({ label, value, trend, tone, Icon }) => (
    <article className={`exact-kpi-card exact-kpi-${tone}`} key={label}>
      <div className="exact-kpi-label"><Icon size={13} strokeWidth={1.8} />{label}</div>
      <strong>{value}</strong>
      <div className="exact-kpi-trend">{trend}</div>
      <div className="exact-kpi-chart" aria-hidden="true"><TrendingUp size={78} strokeWidth={1.4} /></div>
    </article>
  ))
}

function ExactWorkingStrip() {
  return (
    <div className="exact-working-strip">
      <div className="exact-working-mark"><Sparkles size={25} /></div>
      <div className="exact-working-copy">
        <strong>What Duewatch is working on</strong>
        <div className="exact-working-facts">
          <span><Mail size={14} />5 reminders sent</span>
          <span><MessageCircle size={14} />2 replies received</span>
          <span><CircleDollarSign size={14} />1 payment logged</span>
          <span><Users size={14} />3 invoices need your decision</span>
        </div>
      </div>
      <button type="button">View Autopilot activity <ArrowRight size={14} /></button>
    </div>
  )
}

function ExactDueTag({ label, tone }) {
  return <span className={`exact-due-tag exact-due-${tone}`}>{label}</span>
}

function ExactAssistant() {
  return (
    <div className="exact-assistant">
      <div className="exact-impact">
        <h2>Autopilot impact this month</h2>
        <div className="exact-impact-metrics">
          <div><CircleDollarSign /><strong>13</strong><span>Invoices handled<br /><small>77% of total</small></span></div>
          <div><Clock3 /><strong>8.5 hrs</strong><span>Time saved<br /><small>vs manual follow-up</small></span></div>
          <div><CircleDollarSign /><strong>$19,200</strong><span>Value generated<br /><small>from autopilot actions</small></span></div>
          <div><Zap /><strong>94%</strong><span>Response rate<br /><small>to autopilot emails</small></span></div>
        </div>
      </div>
      <img className="exact-assistant-image" src={assistantMascot} alt="Duewatch assistant waving" />
      <div className="exact-assistant-status">
        <h3><span />Autopilot is on</h3>
        <p>Running smoothly and keeping<br />your cash flow moving.</p>
        <button type="button">Manage Autopilot rules <ArrowRight size={14} /></button>
      </div>
    </div>
  )
}

function ExactRail() {
  return (
    <div className="exact-rail">
      <section className="exact-rail-section exact-approvals">
        <header><strong>Needs your approval</strong><span>3</span></header>
        {approvals.map(([title, context, amount]) => (
          <article key={title}>
            <div className="exact-rail-row"><CalendarDays size={15} /><div><strong>{title}</strong><small>{context}</small><em>{amount}</em></div></div>
            <div className="exact-approval-actions"><button>Review</button><button>View</button></div>
          </article>
        ))}
        <a href="#activity">View all approvals <ArrowRight size={13} /></a>
      </section>
      <section className="exact-rail-section exact-scheduled">
        <header><strong>Duewatch will do next</strong><span>3</span></header>
        {scheduled.map(([title, context, when]) => (
          <div className="exact-rail-row" key={`${title}-${context}`}><CalendarDays size={15} /><div><strong>{title}</strong><small>{context}<br />{when}</small></div></div>
        ))}
        <a href="#activity">View full schedule <ArrowRight size={13} /></a>
      </section>
      <section className="exact-rail-section exact-evidence">
        <header><strong>Evidence</strong><span className="exact-live"><i />Live</span></header>
        {evidence.map(([title, context, when, Icon]) => (
          <div className="exact-rail-row" key={title}><Icon size={15} /><div><strong>{title}</strong><small>{context}<br />{when}</small></div></div>
        ))}
        <a href="#activity">View all activity <ArrowRight size={13} /></a>
      </section>
    </div>
  )
}

const navItems = [
  [PulseIcon, 'Pulse', ''],
  [FileText, 'Invoices', '17'],
  [Users, 'Clients', ''],
  [TrendingUp, 'Cash Flow', ''],
  [Sparkles, 'Autopilot', ''],
  [Bell, 'Activity', ''],
  [BarChart3, 'Reports', ''],
  [Settings, 'Settings', ''],
]

function ExactSidebar() {
  return (
    <>
      <div className="exact-sidebar-brand"><LogoMark /><div><strong>Duewatch</strong><span>Your AI Receivables Employee</span></div></div>
      <nav className="exact-sidebar-nav">
        {navItems.map(([Icon, label, badge], index) => <a className={index === 0 ? 'active' : ''} href="#" key={label}><Icon />{label}{badge && <span>{badge}</span>}</a>)}
      </nav>
      <section className="exact-presence-card">
        <h3><i />Autopilot is active</h3>
        <strong>Watching 17 invoices</strong>
        <p>13 handled automatically<br />1 needs your approval</p>
        <small>Last action: 2m ago <ArrowRight size={12} /></small>
      </section>
      <section className="exact-sidebar-evidence">
        <h3>Evidence (24H)</h3>
        <p>27 actions recorded</p><p>18 reminders sent</p><p>6 promises recorded</p><p>3 invoices marked paid</p>
        <a href="#activity">View all activity <ArrowRight size={12} /></a>
      </section>
      <footer className="exact-profile"><span>FJ</span><div><strong>Farhan Jama</strong><small>Founder</small></div><ChevronDown /></footer>
    </>
  )
}

function ExactTargetLayer() {
  const [targets, setTargets] = useState(null)

  useLayoutEffect(() => {
    if (!exactMode) return undefined
    document.body.classList.add('exact-target')
    const frame = requestAnimationFrame(() => setTargets({
      header: document.querySelector('.brief-header-sub'),
      kpis: document.querySelector('.kpi-grid'),
      working: document.querySelector('.working-on-strip'),
      assistant: document.querySelector('.assistant-panel'),
      rail: document.querySelector('.pulse-rail'),
      sidebar: document.querySelector('.sidebar'),
      dueHead: document.querySelector('.due-soon-card .section-head'),
      dueRows: [...document.querySelectorAll('.due-soon-card .invoice-row')],
      overdueCard: document.querySelector('.brief-row-2col > .brief-card:first-child'),
      dueCard: document.querySelector('.due-soon-card'),
    }))
    return () => {
      cancelAnimationFrame(frame)
      document.body.classList.remove('exact-target')
    }
  }, [])

  if (!targets) return null
  return (
    <>
      {targets.header && createPortal(<p className="exact-header-status"><i /> <b>Autopilot active</b><span>• monitoring 17 invoices</span><span>• 13 handled automatically</span><span>• 1 needs your approval</span><span className="exact-info">i</span></p>, targets.header)}
      {targets.kpis && createPortal(<ExactKpis />, targets.kpis)}
      {targets.working && createPortal(<ExactWorkingStrip />, targets.working)}
      {targets.assistant && createPortal(<ExactAssistant />, targets.assistant)}
      {targets.rail && createPortal(<ExactRail />, targets.rail)}
      {targets.sidebar && createPortal(<ExactSidebar />, targets.sidebar)}
      {targets.dueHead && createPortal(<><h2 className="exact-due-title">Due soon &amp; scheduled actions</h2><span className="section-count exact-due-count">4</span></>, targets.dueHead)}
      {targets.dueRows?.map((row, index) => createPortal(
        <ExactDueTag
          key={index}
          label={['Scheduled', 'Scheduled', 'Draft', 'Needs approval'][index]}
          tone={['green', 'green', 'blue', 'amber'][index]}
        />,
        row,
      ))}
      {targets.overdueCard && createPortal(<a className="exact-card-link" href="#invoices">View all invoices <ArrowRight size={13} /></a>, targets.overdueCard)}
      {targets.dueCard && createPortal(<a className="exact-card-link" href="#invoices">View all scheduled actions <ArrowRight size={13} /></a>, targets.dueCard)}
    </>
  )
}

function VisualPulseHarness() {
  return (
    <BrowserRouter>
      <PresenceProvider>
        <div className="app-shell">
          <Sidebar />
          <main className="content">
            <Dashboard />
          </main>
          <ExactTargetLayer />
        </div>
      </PresenceProvider>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <VisualPulseHarness />
  </React.StrictMode>
)
