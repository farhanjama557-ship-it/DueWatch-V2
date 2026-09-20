import {
  Activity,
  BarChart3,
  Bell,
  CalendarCheck2,
  CalendarDays,
  Check,
  CircleAlert,
  CircleDollarSign,
  CircleHelp,
  CircleUserRound,
  CircleX,
  Clock3,
  Code2,
  Database,
  Eye,
  FileClock,
  FilePenLine,
  FileText,
  Filter,
  Flag,
  Handshake,
  Heart,
  HeartPulse,
  Hourglass,
  Inbox,
  Landmark,
  Layers3,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  Moon,
  MoreHorizontal,
  Network,
  Pencil,
  Plane,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  ShieldCheck,
  StickyNote,
  Sun,
  Tag,
  Target,
  Trash2,
  TrendingUp,
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
  cashFlow: BarChart3,
  autopilot: Workflow,
  activity: Activity,
  reports: BarChart3,
  integrations: Layers3,
  settings: Shield,

  search: Search,
  notifications: Bell,
  profile: CircleUserRound,

  normal: Sun,
  nightShift: Moon,
  cashRecovery: TrendingUp,
  protect: Shield,
  away: Plane,
  quarterEnd: CalendarDays,

  cashAwareness: Landmark,
  payments: CircleDollarSign,
  evidence: ShieldCheck,
  reminders: CalendarCheck2,
  clientMemory: UserRound,
  activityStream: HeartPulse,

  clientProfile: UserRound,
  contact: CircleUserRound,
  phone: CircleUserRound,
  communication: MessageCircle,
  clientHealth: Heart,
  segments: Tag,
  notes: StickyNote,

  aging: Hourglass,
  collections: Target,
  disputes: MessagesSquare,
  promises: Handshake,
  overdue: Clock3,
  priorities: FilePenLine,
  writeOffs: FileClock,

  live: Activity,
  processing: LoaderCircle,
  verified: Check,
  scheduled: CalendarDays,
  sent: Send,
  received: Inbox,
  needsApproval: CircleAlert,
  failed: CircleX,

  highConfidence: BarChart3,
  mediumConfidence: BarChart3,
  lowConfidence: BarChart3,
  policyConflict: CircleAlert,
  protected: Shield,

  add: Plus,
  edit: Pencil,
  view: Eye,
  filter: Filter,
  more: MoreHorizontal,
  delete: Trash2,

  calendar: CalendarDays,
  clock: Clock3,
  recurring: RefreshCw,
  snooze: Moon,
  deadline: Flag,

  security: ShieldCheck,
  api: Code2,
  webhooks: Network,
  database: Database,
  help: CircleHelp,
}

export const DUEWATCH_ICON_META = Object.freeze({
  navigation: ['pulse', 'invoices', 'clients', 'promise', 'cashFlow', 'autopilot', 'activity', 'reports', 'integrations', 'settings'],
  utility: ['search', 'notifications', 'profile'],
  autopilotModes: ['normal', 'nightShift', 'cashRecovery', 'protect', 'away', 'quarterEnd'],
  homeOrbit: ['cashAwareness', 'payments', 'evidence', 'reminders', 'clientMemory', 'activityStream'],
  relationship: ['clientProfile', 'contact', 'communication', 'clientHealth', 'segments', 'notes'],
  receivables: ['aging', 'collections', 'disputes', 'promises', 'overdue', 'priorities', 'writeOffs'],
  status: ['live', 'processing', 'verified', 'scheduled', 'sent', 'received', 'needsApproval', 'failed'],
  confidence: ['highConfidence', 'mediumConfidence', 'lowConfidence', 'policyConflict', 'protected'],
  actions: ['add', 'edit', 'view', 'filter', 'more', 'delete'],
  scheduling: ['calendar', 'clock', 'recurring', 'snooze', 'deadline'],
  platform: ['security', 'api', 'webhooks', 'database', 'help'],
})

const DEFAULT_TONE = {
  pulse: 'orange',
  invoices: 'navy',
  clients: 'navy',
  promise: 'navy',
  cashFlow: 'green',
  autopilot: 'orange',
  activity: 'navy',
  reports: 'navy',
  integrations: 'navy',
  settings: 'navy',

  normal: 'orange',
  nightShift: 'violet',
  cashRecovery: 'green',
  protect: 'pink',
  away: 'blue',
  quarterEnd: 'violet',

  cashAwareness: 'green',
  payments: 'orange',
  evidence: 'blue',
  reminders: 'orange',
  clientMemory: 'violet',
  activityStream: 'blue',

  clientProfile: 'violet',
  contact: 'blue',
  communication: 'green',
  clientHealth: 'green',
  segments: 'pink',
  notes: 'navy',

  aging: 'orange',
  collections: 'pink',
  disputes: 'orange',
  promises: 'amber',
  overdue: 'red',
  priorities: 'navy',
  writeOffs: 'navy',

  live: 'green',
  processing: 'blue',
  verified: 'blue',
  scheduled: 'violet',
  sent: 'blue',
  received: 'green',
  needsApproval: 'orange',
  failed: 'red',

  highConfidence: 'green',
  mediumConfidence: 'amber',
  lowConfidence: 'red',
  policyConflict: 'red',
  protected: 'navy',

  add: 'green',
  edit: 'navy',
  view: 'navy',
  filter: 'navy',
  more: 'navy',
  delete: 'red',

  calendar: 'blue',
  clock: 'blue',
  recurring: 'blue',
  snooze: 'blue',
  deadline: 'red',

  security: 'blue',
  api: 'navy',
  webhooks: 'navy',
  database: 'navy',
  help: 'navy',
}

export function DueWatchIcon({
  name,
  size = 18,
  tone,
  tile = false,
  className = '',
  strokeWidth = 2,
  ...props
}) {
  const Icon = ICONS[name] || CircleHelp
  const resolvedTone = tone || DEFAULT_TONE[name] || 'navy'

  if (!tile) {
    return (
      <Icon
        size={size}
        strokeWidth={strokeWidth}
        className={['dw-icon', 'dw-icon-' + resolvedTone, className].filter(Boolean).join(' ')}
        aria-hidden="true"
        {...props}
      />
    )
  }

  return (
    <span
      className={['dw-icon-tile', 'dw-icon-tile-' + resolvedTone, className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <Icon size={size} strokeWidth={strokeWidth} />
    </span>
  )
}

export function DueWatchLogoMark({ size = 32, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="dwLogoGradient" x1="14" y1="9" x2="50" y2="55" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff8a35" />
          <stop offset="1" stopColor="#ff4b0b" />
        </linearGradient>
      </defs>
      <path
        d="M32 3.5 56 17.3v29.4L32 60.5 8 46.7V17.3L32 3.5Z"
        fill="url(#dwLogoGradient)"
      />
      <circle cx="32" cy="32" r="14" stroke="white" strokeWidth="4" />
      <path d="M44 19.8 51.5 24v8.5" stroke="#ffd2ba" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
