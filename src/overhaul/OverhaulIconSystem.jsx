import {
  Activity,
  BarChart3,
  Bell,
  CalendarCheck2,
  CircleAlert,
  CircleDollarSign,
  CircleHelp,
  Clock3,
  FileText,
  Landmark,
  Layers3,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'

const ICONS = {
  pulse: Zap,
  invoices: FileText,
  clients: Users,
  promise: CalendarCheck2,
  cash: CircleDollarSign,
  autopilot: Workflow,
  activity: Activity,
  reports: BarChart3,
  integrations: Layers3,
  settings: Settings,
  search: Search,
  notifications: Bell,
  cashAwareness: Landmark,
  payments: CircleDollarSign,
  evidence: ShieldCheck,
  reminders: CalendarCheck2,
  memory: UserRound,
  activityStream: Activity,
  alert: CircleAlert,
  send: Send,
  clock: Clock3,
  help: CircleHelp,
  sparkle: Sparkles,
}

export function OverhaulIcon({ name, size = 18, className = '', ...props }) {
  const Icon = ICONS[name] || CircleHelp
  return <Icon size={size} strokeWidth={1.8} className={className} aria-hidden="true" {...props} />
}

export function DueWatchMark({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="duewatchMarkGradient" x1="12" y1="8" x2="51" y2="57" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff8a35" />
          <stop offset="1" stopColor="#ff4b0b" />
        </linearGradient>
      </defs>
      <path d="M32 3.8 55.5 17v30L32 60.2 8.5 47V17L32 3.8Z" fill="url(#duewatchMarkGradient)" />
      <circle cx="32" cy="32" r="14.2" stroke="#fff" strokeWidth="4" />
      <path d="M43.7 19.7 51 24v8.3" stroke="#ffd2ba" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
