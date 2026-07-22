// Thin wrapper around the Resend REST API. Runs server-side only (Edge
// Function) — RESEND_API_KEY is a Supabase Edge Function secret and must
// never be sent to or read by the browser.
const RESEND_API_URL = 'https://api.resend.com/emails'

// TODO: replace with a sender address on a domain verified in the Resend
// account (Resend rejects unverified From domains). Until then, sends will
// fail with a clear Resend error naming the problem — see the deploy notes.
const DEFAULT_FROM = 'Duewatch <reminders@duewatch.app>'

export async function sendEmail({ to, subject, text, from }) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    return { error: 'RESEND_API_KEY is not configured as an Edge Function secret.' }
  }
  if (!to) {
    return { error: 'No recipient email address was provided.' }
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
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
