// Locked Lucide icon set (Session 7 Design System Additions). No icon
// appears in more than one context — `Bot` is reserved exclusively for
// Autopilot-as-actor, never for a lifecycle stage like "drafted".
import {
  Bot,
  FileText,
  PenSquare,
  CheckCircle,
  Send,
  Eye,
  CircleDollarSign,
  XCircle,
  AlertCircle,
  AlertTriangle,
  PauseCircle,
  Settings,
  User,
  UserCircle,
} from 'lucide-react'

export const LIFECYCLE_ICON = {
  autopilot_actor: { Icon: Bot, size: 16, color: 'var(--primary)' },
  drafted: { Icon: FileText, size: 14, color: 'var(--green)' },
  awaiting_signature: { Icon: PenSquare, size: 14, color: 'var(--primary)' },
  approved: { Icon: CheckCircle, size: 14, color: 'var(--green)' },
  sent: { Icon: Send, size: 14, color: 'var(--text-primary)' },
  opened: { Icon: Eye, size: 14, color: 'var(--blue)' },
  paid: { Icon: CircleDollarSign, size: 14, color: 'var(--green)' },
  skipped: { Icon: XCircle, size: 14, color: 'var(--text-muted)' },
  error: { Icon: AlertCircle, size: 14, color: 'var(--red)' },
  error_banner: { Icon: AlertTriangle, size: 20, color: 'var(--red)' },
  paused: { Icon: PauseCircle, size: 14, color: 'var(--blue)' },
  system: { Icon: Settings, size: 14, color: 'var(--text-muted)' },
  client_avatar: { Icon: User, size: 14, color: 'var(--blue)' },
  founder_avatar: { Icon: UserCircle, size: 16, color: 'var(--text-primary)' },
}

// Maps an events.event_type to its lifecycle stage icon key.
export function lifecycleKeyFor(eventType) {
  switch (eventType) {
    case 'reminder_opened':
      return 'drafted'
    case 'reminder_sent':
      return 'sent'
    case 'reminder_skipped':
      return 'skipped'
    case 'payment_recorded':
    case 'invoice_marked_paid':
      return 'paid'
    case 'invoice_created':
      return 'system'
    default:
      return 'system'
  }
}
