// Callable Edge Function — the ONLY place that talks to Resend on behalf of
// a signed-in founder's manual/approved sends (SignatureCard "Approve & Send"
// and "Edit First", InvoiceDetailPanel "Send reminder"). The React app never
// holds RESEND_API_KEY; it calls this function instead.
//
// Deploy: supabase functions deploy send-reminder-email
// Invoke from the app: supabase.functions.invoke('send-reminder-email', { body: {...} })
//
// Request body: { invoiceId, subject?, body }
// Requires a valid user session (Authorization header) — verifies the
// invoice belongs to the caller before sending anything.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendEmail } from '../_shared/resend.js'
import { corsHeaders } from '../_shared/cors.js'

Deno.serve(async (req) => {
  // Browser preflight — must return the CORS headers with no auth check,
  // or the actual POST never gets sent by the browser at all.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) {
      return json({ error: 'Not authenticated' }, 401)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    )

    const {
      data: { user },
      error: userErr,
    } = await admin.auth.getUser(jwt)
    if (userErr || !user) {
      return json({ error: 'Not authenticated' }, 401)
    }

    const { invoiceId, subject, body } = await req.json()
    if (!invoiceId || !body) {
      return json({ error: 'invoiceId and body are required' }, 400)
    }

    const { data: invoice, error: invErr } = await admin
      .from('invoices')
      .select('id, user_id, inv_num, clients(email, name)')
      .eq('id', invoiceId)
      .maybeSingle()

    if (invErr || !invoice) {
      return json({ error: 'Invoice not found' }, 404)
    }
    if (invoice.user_id !== user.id) {
      return json({ error: 'Not authorized for this invoice' }, 403)
    }

    // ASSUMPTION: clients.email is the real recipient column. Flagged for
    // the founder to confirm — if it errors here, this is the one line to fix.
    const to = invoice.clients?.email
    if (!to) {
      return json(
        { error: `${invoice.clients?.name || 'This client'} has no email on file.` },
        422
      )
    }

    const result = await sendEmail({
      to,
      subject: subject || `Regarding invoice ${invoice.inv_num || ''}`.trim(),
      text: body,
    })

    if (result.error) {
      return json({ error: result.error }, 502)
    }

    return json({ ok: true, id: result.id, status: result.status })
  } catch (err) {
    return json({ error: err?.message || 'Unexpected error' }, 500)
  }
})

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}
