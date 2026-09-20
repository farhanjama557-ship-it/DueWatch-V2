// Thin wrapper around the Resend REST API. Runs server-side only (Edge
// Function) — RESEND_API_KEY is a Supabase Edge Function secret and must
// never be sent to or read by the browser.
const RESEND_API_URL = 'https://api.resend.com/emails'

// Resend's shared sandbox address — works without a verified domain, for
// end-to-end testing. Swap to a verified domain (e.g. reminders@duewatch.app)
// before going live; see DEPLOY.md §4.
const DEFAULT_FROM = 'Duewatch <onboarding@resend.dev>'
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// HIGH 1 (post-2A.1 execution safety review-fix): a missing API key is a
// provable pre-send failure — checkable without making an external
// request. Callers of the execution-claim boundary must check this BEFORE
// acquiring a durable claim, so a misconfigured deployment never
// permanently consumes an execution identity for zero external attempts.
export function isProviderConfigured() {
  return Boolean(Deno.env.get('RESEND_API_KEY'))
}

function validateAttachments(attachments) {
  if (attachments == null) return { ok: true, value: undefined }
  if (!Array.isArray(attachments)) return { ok: false, error: 'Attachments must be an array.' }
  if (attachments.length > 5) return { ok: false, error: 'Too many email attachments.' }

  const normalized = []
  let estimatedBytes = 0

  for (const attachment of attachments) {
    const filename = String(attachment?.filename ?? '').trim()
    const content = String(attachment?.content ?? '').trim()
    const contentType = attachment?.contentType
      ? String(attachment.contentType).trim()
      : undefined

    if (!filename || filename.length > 180) {
      return { ok: false, error: 'Each attachment requires a valid filename.' }
    }
    if (!content) {
      return { ok: false, error: 'Each attachment requires base64 content.' }
    }

    // Base64 expands raw bytes by about 4/3. This bound is intentionally
    // conservative and protects the Edge Function from oversized report
    // payloads before an external send is attempted.
    estimatedBytes += Math.ceil((content.length * 3) / 4)
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: 'Email attachments exceed the supported size.' }
    }

    normalized.push({
      filename,
      content,
      ...(contentType ? { content_type: contentType } : {}),
    })
  }

  return { ok: true, value: normalized }
}

export async function sendEmail({
  to,
  subject,
  text,
  from,
  idempotencyKey,
  attachments = undefined,
}) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    return { error: 'RESEND_API_KEY is not configured as an Edge Function secret.' }
  }
  if (!to) {
    return { error: 'No recipient email address was provided.' }
  }

  const attachmentValidation = validateAttachments(attachments)
  if (!attachmentValidation.ok) {
    return { error: attachmentValidation.error }
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  // Provider idempotency is secondary protection only — Duewatch's durable
  // execution claims remain authoritative. Report deliveries use the stable
  // schedule occurrence as the provider idempotency key as a second guard
  // against a retry after an ambiguous network result.
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }

  const payload = {
    from: from || DEFAULT_FROM,
    to: [to],
    subject,
    text,
  }
  if (attachmentValidation.value?.length) {
    payload.attachments = attachmentValidation.value
  }

  let res
  try {
    res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Email provider network failure.',
      ambiguous: true,
    }
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return {
      error: data?.message || `Resend request failed (HTTP ${res.status})`,
      // A 5xx means the provider-side outcome cannot be proven from the
      // response alone. 4xx/429 responses are treated as definite rejects.
      ambiguous: res.status >= 500,
      statusCode: res.status,
    }
  }
  return { id: data.id, status: 'sent', ambiguous: false }
}
