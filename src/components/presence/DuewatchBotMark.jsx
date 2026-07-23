import { Bot } from 'lucide-react'

/**
 * Shared Presence System Bot mark — the one visual anchor used everywhere
 * Duewatch represents itself as an actor (sidebar PresenceIndicator,
 * CognitiveCompose). Extracted so there's exactly one implementation, not
 * a second one drifting in a modal.
 *
 * The mark itself never animates (no rotate/bounce/shake/scale/opacity
 * change) — "the employee remains steady, the work moves around it."
 * When `cognitive` is true, the rotating dual-ring + pulsing core dot
 * render around it; the icon stays still either way.
 */
export default function DuewatchBotMark({ cognitive = false, iconSize = 18 }) {
  return (
    <span className="presence-mark" aria-hidden="true">
      {cognitive && (
        <span className="cognitive-ring">
          <span className="ring-outer" />
          <span className="ring-inner" />
          <span className="ring-core" />
        </span>
      )}
      <Bot size={iconSize} />
    </span>
  )
}
