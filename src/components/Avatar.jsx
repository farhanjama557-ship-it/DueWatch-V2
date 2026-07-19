import { initials } from '../lib/format'

// Gray circle with 2-letter initials. `size` in px (default 36).
export default function Avatar({ name, size = 36 }) {
  return (
    <span
      className="avatar-initials"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}
