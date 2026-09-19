import { Activity, Banknote, CalendarClock, DatabaseZap, Landmark, Users, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatMoney } from '../lib/format'

function PulseNode({ icon: Icon, label, value, note, tone = 'orange', side }) {
  return (
    <article className={`v1-pulse-node tone-${tone} side-${side}`}>
      <span className="v1-pulse-node-icon"><Icon size={17}/></span>
      <div><strong>{label}</strong><b>{value}</b><span>{note}</span></div>
    </article>
  )
}

export default function PulseOrbHub({
  outstanding = 0,
  collected = 0,
  reminders = 0,
  events = 0,
  clients = 0,
  proofEntries = 0,
  liveCount = 0,
  needsYou = 0,
  autopilotEnabled = false,
}) {
  const state = needsYou > 0 ? 'attention' : liveCount > 0 ? 'processing' : autopilotEnabled ? 'observing' : 'resting'
  const stateCopy = state === 'attention' ? 'Needs your judgment' : state === 'processing' ? 'Investigating current signals' : state === 'observing' ? 'Watching receivables' : 'Ready when work appears'

  return (
    <section className={`v1-pulse-orb-room state-${state}`} aria-label="DueWatch Pulse">
      <div className="v1-pulse-side left">
        <PulseNode side="left" icon={Landmark} label="Cash awareness" value={formatMoney(outstanding)} note="canonical outstanding" tone="green" />
        <PulseNode side="left" icon={Banknote} label="Payments" value={formatMoney(collected)} note="recorded this month" tone="orange" />
        <PulseNode side="left" icon={DatabaseZap} label="Evidence" value={`${proofEntries}`} note="proven DW entries" tone="blue" />
      </div>

      <div className="v1-pulse-core-wrap">
        <div className="v1-pulse-rings" aria-hidden="true"><i/><i/><i/></div>
        <div className="v1-pulse-orb" aria-hidden="true"><span className="v1-pulse-orb-core"/><span className="v1-pulse-orb-sheen"/></div>
        <div className="v1-pulse-core-copy">
          <strong>DW Pulse</strong>
          <span>{stateCopy}</span>
          <Link to="/ask-dw">Ask DW <ArrowRight size={13}/></Link>
        </div>
      </div>

      <div className="v1-pulse-side right">
        <PulseNode side="right" icon={CalendarClock} label="Reminders & follow-ups" value={`${reminders}`} note="recorded this week" tone="orange" />
        <PulseNode side="right" icon={Users} label="Client context" value={`${clients}`} note="client records available" tone="green" />
        <PulseNode side="right" icon={Activity} label="Activity stream" value={`${events}`} note={liveCount > 0 ? `${liveCount} live investigation${liveCount === 1 ? '' : 's'}` : 'recorded operational events'} tone="orange" />
      </div>
    </section>
  )
}
