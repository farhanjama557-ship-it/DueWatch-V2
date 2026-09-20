import { createClient } from 'npm:@supabase/supabase-js@2'
import { isProviderConfigured, sendEmail } from '../_shared/resend.js'
import { processClaimedReportRun } from '../_shared/reportDeliveryCore.js'

type JsonBody = Record<string, unknown>

type CompletionInput = {
  runId: string
  leaseToken: string
  status: 'sent' | 'failed' | 'skipped'
  provider?: string | null
  providerMessageId?: string | null
  artifactSha256?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  nextRunAt?: string | null
}

function json(body: JsonBody, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function constantTimeEqual(a: string | null | undefined, b: string | null | undefined) {
  const left = new TextEncoder().encode(String(a ?? ''))
  const right = new TextEncoder().encode(String(b ?? ''))
  const length = Math.max(left.length, right.length)
  let diff = left.length ^ right.length
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0)
  }
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const expectedSecret = Deno.env.get('REPORT_SCHEDULER_SECRET')
  const suppliedSecret = req.headers.get('x-duewatch-scheduler-secret')
  if (!expectedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return json({ error: 'Not authorized' }, 401)
  }

  if (!isProviderConfigured()) {
    // Check before claiming anything. A deployment missing provider
    // configuration must never consume a durable delivery attempt.
    return json({ error: 'Email provider is not configured' }, 503)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Server database configuration is incomplete' }, 503)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const now = new Date().toISOString()
  const { data: claims, error: claimError } = await admin.rpc('claim_due_report_runs', {
    p_now: now,
    p_limit: 10,
    p_lease_minutes: 15,
    p_max_attempts: 5,
  })

  if (claimError) {
    return json({ error: claimError.message || 'Could not claim due reports' }, 500)
  }

  const results = []
  for (const claim of claims || []) {
    try {
      const result = await processClaimedReportRun({
        database: admin,
        claim,
        sendEmail,
        completeRun: async ({
          runId,
          leaseToken,
          status,
          provider = null,
          providerMessageId = null,
          artifactSha256 = null,
          errorCode = null,
          errorDetail = null,
          nextRunAt = null,
        }: CompletionInput) => {
          const { error } = await admin.rpc('complete_report_delivery_run', {
            p_run_id: runId,
            p_lease_token: leaseToken,
            p_status: status,
            p_provider: provider,
            p_provider_message_id: providerMessageId,
            p_artifact_sha256: artifactSha256,
            p_error_code: errorCode,
            p_error_detail: errorDetail,
            p_next_run_at: nextRunAt,
          })
          if (error) throw new Error(error.message || 'Could not complete report delivery run.')
        },
      })
      results.push(result)
    } catch (error) {
      results.push({
        ok: false,
        runId: claim.run_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return json({
    ok: true,
    checkedAt: now,
    claimed: claims?.length || 0,
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  })
})
