import {
  assertPhase2BWriteContract,
  mapEvidenceInsert,
  mapProofEventInsert,
  mapRunFinalize,
  mapRunInsert,
} from './dwIntelligencePhase2bPersistenceMapper.js'

function ensureDb(db) {
  for (const method of ['insertOne', 'insertMany', 'updateOne']) {
    if (typeof db?.[method] !== 'function') throw new Error(`db.${method} is required`)
  }
}

/**
 * Local/server persistence adapter over a deliberately tiny DB interface.
 *
 * This is not a network client and contains no Supabase import. A future
 * repository-specific Supabase adapter can implement insertOne/insertMany/
 * updateOne while preserving this already-tested mapping contract.
 */
export function createPhase2BPersistenceIo({ db, caseLoader } = {}) {
  ensureDb(db)
  if (typeof caseLoader !== 'function') throw new Error('caseLoader is required')

  let activeRunInsert = null
  let lastProofEvent = null
  let evidenceRows = []

  return {
    async fetchCaseInputs({ userId, invoiceId }) {
      return caseLoader({ userId, invoiceId })
    },

    async createRun(input) {
      const row = mapRunInsert(input)
      activeRunInsert = row
      const inserted = await db.insertOne('dw_intelligence_runs', row)
      if (!inserted?.id) throw new Error('dw_intelligence_runs insert did not return id')
      return inserted
    },

    async persistEvidence(inputs) {
      const rows = (inputs || []).map(mapEvidenceInsert)
      evidenceRows = rows
      if (rows.length) await db.insertMany('dw_evidence_items', rows)
    },

    async persistProofEvent(input) {
      const row = mapProofEventInsert(input)
      lastProofEvent = row
      // Validate the full bundle before the consequential proof row is stored.
      // The SQL schema independently re-checks production/side-effect fields.
      assertPhase2BWriteContract({
        runInsert: activeRunInsert,
        evidenceRows,
        proofEvent: row,
      })
      await db.insertOne('dw_proof_events', row)
    },

    async finalizeRun(input) {
      const update = mapRunFinalize(input)
      if (lastProofEvent) {
        assertPhase2BWriteContract({
          runInsert: activeRunInsert,
          evidenceRows,
          proofEvent: lastProofEvent,
          runFinalize: update,
        })
      }
      await db.updateOne('dw_intelligence_runs', { id: input.runId, user_id: input.userId }, update)
    },
  }
}
