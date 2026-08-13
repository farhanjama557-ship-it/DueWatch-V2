// Thin wrapper around the Resend REST API. Runs server-side only (Edge
// Function) — RESEND_API_KEY is a Supabase Edge Function secret and must
// never be sent to or read by the browser.
const RESEND_API_URL = 'https://api.resend.com/emails'

// Resend's shared sandbox address — works without a verified domain, for
// end-to-end testing. Swap to a verified domain (e.g. reminders@duewatch.app)
// before going live; see DEPLOY.md §4.
const DEFAULT_FROM = 'Duewatch <onboarding@resend.dev>'

// HIGH 1 (post-2A.1 execution safety review-fix): a missing API key is a
// provable pre-send failure — checkable without making an external
// request. Callers of the execution-claim boundary must check this BEFORE
// acquiring a durable claim, so a misconfigured deployment never
// permanently consumes an execution identity for zero external attempts.
export function isProviderConfigured() {
  return Boolean(Deno.env.get('RESEND_API_KEY'))
}

export async function sendEmail({ to, subject, text, from, idempotencyKey }) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    return { error: 'RESEND_API_KEY is not configured as an Edge Function secret.' }
  }
  if (!to) {
    return { error: 'No recipient email address was provided.' }
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  // Provider idempotency is secondary protection only — Duewatch's durable
  // execution claim (autopilot_execution_claims) is authoritative, since
  // Resend's own idempotency-key retention window is bounded. Callers that
  // don't pass one (e.g. manual sends outside the Autopilot execution-claim
  // path) get Resend's normal at-least-once behavior, unchanged.
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: from || DEFAULT_FROM,
      to: [to],
      subject,
      text,
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { error: data?.message || `Resend request failed (HTTP ${res.status})` }
  }
  return { id: data.id, status: 'sent' }
}
