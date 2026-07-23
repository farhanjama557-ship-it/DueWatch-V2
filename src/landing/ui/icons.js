// Locked icon set for this page (Unified Spec §16) — Lucide only, no emoji,
// no handcrafted SVG. Status colors are never the sole signal (§7 rules,
// §15 a11y) — every icon here always renders alongside the exact state
// name and explanatory text, never instead of them.
import { Bot, Check, AlertCircle, CircleAlert, Clock3, PenLine, Send, Pause, ReceiptText, Eye } from 'lucide-react'

export const PRESENCE_ICON = {
  Celebratory: Check,
  Error: AlertCircle,
  Active: CircleAlert,
  Contextual: PenLine,
  Cognitive: Bot,
  Resting: Clock3,
  Off: Pause,
}

export const EVIDENCE_ICON = {
  checked: Check,
  drafted: PenLine,
  awaiting_signature: PenLine,
  approved: Check,
  sent: Send,
  opened: Eye,
  skipped: Pause,
  error: AlertCircle,
  paid: ReceiptText,
}
