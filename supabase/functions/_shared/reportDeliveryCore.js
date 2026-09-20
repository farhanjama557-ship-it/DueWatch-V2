import { loadReportsSourceData } from '../../../src/lib/reports/reportDataSource.js'
import { buildReportsReadModel } from '../../../src/lib/reports/reportReadModel.js'
import { buildReportCsv, reportExportFilename } from '../../../src/lib/reports/reportExport.js'
import { computeNextReportRun } from '../../../src/lib/reports/reportSchedule.js'

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function reportDeliveryIdempotencyKey(claim) {
  if (!claim?.schedule_id || !claim?.scheduled_for) {
    throw new Error('Schedule id and scheduled_for are required for idempotency.')
  }
  return 'duewatch-report:' + claim.schedule_id + ':' + claim.scheduled_for
}

export function reportDeliverySubject(claim) {
  return 'DueWatch report · ' + claim.period_start + ' to ' + claim.period_end
}

export async function buildScheduledReportArtifact({ database, claim }) {
  if (!database) throw new Error('A database client is required.')
  if (!claim?.user_id) throw new Error('Claim user id is required.')
  if (!claim?.period_start || !claim?.period_end) throw new Error('Claim period is required.')

  const source = await loadReportsSourceData({ database, userId: claim.user_id })
  const model = buildReportsReadModel({
    invoices: source.invoices.rows,
    invoicesAvailable: source.invoices.available,
    payments: source.payments.rows,
    paymentsAvailable: source.payments.available,
    allocations: source.allocations.rows,
    allocationsAvailable: source.allocations.available,
    promises: source.promises.rows,
    promisesAvailable: source.promises.available,
    executionClaims: source.executionClaims.rows,
    executionClaimsAvailable: source.executionClaims.available,
    approvals: source.approvals.rows,
    approvalsAvailable: source.approvals.available,
    events: source.events.rows,
    eventsAvailable: source.events.available,
    asOf: new Date(claim.scheduled_for),
    startDate: claim.period_start,
    endDate: claim.period_end,
  })

  const csv = buildReportCsv(model, { currency: claim.currency || null })
  const hash = await sha256Hex(csv)
  const bytes = new TextEncoder().encode(csv)

  return {
    model,
    csv,
    artifactSha256: hash,
    filename: reportExportFilename(model),
    attachment: {
      filename: reportExportFilename(model),
      content: bytesToBase64(bytes),
      contentType: 'text/csv; charset=utf-8',
    },
    sourceAvailability: Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, value.available === true])
    ),
  }
}

export async function processClaimedReportRun({
  database,
  claim,
  sendEmail,
  completeRun,
}) {
  if (!database) throw new Error('A database client is required.')
  if (!claim?.run_id || !claim?.lease_token) throw new Error('A claimed run and lease are required.')
  if (typeof sendEmail !== 'function') throw new Error('sendEmail is required.')
  if (typeof completeRun !== 'function') throw new Error('completeRun is required.')

  let artifact = null
  try {
    artifact = await buildScheduledReportArtifact({ database, claim })
    const idempotencyKey = reportDeliveryIdempotencyKey(claim)
    const sendResult = await sendEmail({
      to: claim.recipient_email,
      subject: reportDeliverySubject(claim),
      text:
        'Your scheduled DueWatch report is attached as CSV. ' +
        'Any unavailable source is explicitly marked unavailable rather than treated as zero.',
      attachments: [artifact.attachment],
      idempotencyKey,
    })

    if (sendResult?.error) {
      throw new Error(sendResult.error)
    }

    const nextRunAt = computeNextReportRun(
      {
        cadence: claim.cadence,
        weekday: claim.weekday,
        day_of_month: claim.day_of_month,
        local_hour: claim.local_hour,
        timezone: claim.timezone,
      },
      new Date(claim.scheduled_for)
    )

    await completeRun({
      runId: claim.run_id,
      leaseToken: claim.lease_token,
      status: 'sent',
      provider: 'resend',
      providerMessageId: sendResult?.id || null,
      artifactSha256: artifact.artifactSha256,
      nextRunAt,
    })

    return {
      ok: true,
      runId: claim.run_id,
      providerMessageId: sendResult?.id || null,
      nextRunAt,
      artifactSha256: artifact.artifactSha256,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await completeRun({
      runId: claim.run_id,
      leaseToken: claim.lease_token,
      status: 'failed',
      provider: artifact ? 'resend' : null,
      providerMessageId: null,
      artifactSha256: artifact?.artifactSha256 || null,
      errorCode: artifact ? 'REPORT_DELIVERY_FAILED' : 'REPORT_BUILD_FAILED',
      errorDetail: detail,
      nextRunAt: null,
    })

    return {
      ok: false,
      runId: claim.run_id,
      error: detail,
    }
  }
}
