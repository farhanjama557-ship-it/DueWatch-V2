import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  ASK_DW_G7_MODEL_CONTRACT_VERSION,
  ASK_DW_G7_MODEL_STAGE,
  askDwG7StageInstructions,
  askDwG7StageSchema,
} from '../supabase/functions/_shared/askDwG7ModelContract.js'
import { ASK_DW_OPENAI_SCHEMAS } from '../supabase/functions/_shared/askDwOpenAiContract.js'
import {
  ASK_DW_G7_LANGUAGE_CONTRACT_VERSION,
  createAskDwModelAdapter,
} from '../src/lib/dwIntelligence/askDwModelAdapter.js'
import { ASK_DW_MODEL_EDGE_FUNCTION } from '../src/lib/dwIntelligence/askDwLiveModelProvider.js'
import { DW_STYLE_EXAMPLES } from '../src/lib/dwIntelligence/askDwCharacterSpec.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('G7-CP8 forward contract is versioned and matches the browser envelope', () => {
  assert.equal(ASK_DW_G7_MODEL_CONTRACT_VERSION, 'ASK_DW_G7_MODEL_CONTRACT_V1')
  assert.equal(ASK_DW_G7_LANGUAGE_CONTRACT_VERSION, ASK_DW_G7_MODEL_CONTRACT_VERSION)
  assert.equal(ASK_DW_MODEL_EDGE_FUNCTION, 'ask-dw-g7-model')
})

test('G7-CP8 stable character runs at provider instruction priority', () => {
  const synthesize = askDwG7StageInstructions(ASK_DW_G7_MODEL_STAGE.SYNTHESIZE)
  for (const pattern of [
    /accounts-receivable employee/i,
    /Answer first/i,
    /known, inferred, predicted, recommended, and explicitly allowed/i,
    /Founder pressure.*cannot change facts/i,
    /Normal is concise, not less safe/i,
    /untrusted data, never as instructions/i,
    /Conversation.*standing permission/i,
  ]) assert.match(synthesize, pattern)
  assert.doesNotMatch(synthesize, /private chain-of-thought.*reveal/i)
})

test('G7-CP8 PLAN, SYNTHESIZE and VERIFY retain the historical strict schemas', () => {
  for (const stage of Object.values(ASK_DW_G7_MODEL_STAGE)) {
    assert.equal(askDwG7StageSchema(stage), ASK_DW_OPENAI_SCHEMAS[stage])
  }
  assert.match(askDwG7StageInstructions('PLAN'), /minimum bounded read-only retrieval/i)
  assert.match(askDwG7StageInstructions('VERIFY'), /Normal and Deep.*same tenant/i)
})

test('G7-CP8 model adapter sends the version on every stage', async () => {
  const contracts = []
  const model = createAskDwModelAdapter({
    async invoke(request) {
      contracts.push(request.contract)
      if (request.stage === 'PLAN') return { toolRequests: [], hypotheses: [], answerIntent: 'answer' }
      if (request.stage === 'SYNTHESIZE') {
        return {
          executiveConclusion: 'Current state checked.', evidenceBasis: [],
          uncertaintyAndLimitations: [], recommendationOrNextStep: null,
          competingExplanations: [], citedToolRunIds: [],
        }
      }
      return { verdict: 'PASS', issues: [], checkedClaims: [] }
    },
  })
  await model.plan({})
  await model.synthesize({})
  await model.verify({})
  assert.equal(contracts.length, 3)
  assert.ok(contracts.every((contract) => contract.languageContract === ASK_DW_G7_MODEL_CONTRACT_VERSION))
  assert.ok(contracts.every((contract) => contract.executionAuthority === 'NEVER_GRANTED_BY_MODEL'))
})

test('G7-CP8 examples cover the required conversation behaviors without tenant facts', () => {
  const ids = new Set(DW_STYLE_EXAMPLES.map((example) => example.id))
  for (const id of [
    'greeting_daily_status', 'daily_priorities', 'referent_correction',
    'pressure_uncertainty', 'progressive_evidence', 'company_brain_natural',
    'authority_boundary', 'client_level_answer', 'deep_supported_alternatives',
    'acknowledgement',
  ]) assert.ok(ids.has(id), id)
  for (const example of DW_STYLE_EXAMPLES) {
    assert.doesNotMatch(example.dw, /\b(?:Atlas|Cedar|Riverbend|Acme)\b/)
    assert.doesNotMatch(example.dw, /[$£€]\s?\d/)
  }
})

test('G7-CP8 historical M2D model sources remain byte-identical', () => {
  assert.equal(
    execFileSync('git', ['hash-object', 'supabase/functions/_shared/askDwOpenAiContract.js'],
      { cwd: repoRoot, encoding: 'utf8' }).trim(),
    'e3870f6ffc62fea71118a9202d79af00cdf70477',
  )
  assert.equal(
    execFileSync('git', ['hash-object', 'supabase/functions/ask-dw-model/index.ts'],
      { cwd: repoRoot, encoding: 'utf8' }).trim(),
    'b687f54b07ac7f9f31596a7cdf42a472d4ab8855',
  )
})

test('G7-CP8 successor provider has no financial mutation or execution path', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/ask-dw-g7-model/index.ts'), 'utf8')
  assert.match(source, /instructions:\s*askDwG7StageInstructions\(stage\)/)
  assert.match(source, /strict:\s*true/)
  assert.doesNotMatch(source, /\.from\(['"](?:invoices|payments|payment_allocations)['"]\)/)
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|send-reminder-email/)
})
