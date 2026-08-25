import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const adapterPath = path.join(here, '..', 'src', 'lib', 'dwIntelligence', 'phase2bDuewatchAdapter.js')
const source = fs.readFileSync(adapterPath, 'utf8')

test('Phase 2B adapter reuses existing nextActionAuthority instead of inventing policy', () => {
  assert.match(source, /import \{ evaluateNextActionAuthority \} from '\.\.\/nextActionAuthority\.js'/)
  assert.match(source, /const authorityEvaluation = evaluateNextActionAuthority\(/)
})

test('Phase 2B adapter is sandbox-only and contains no provider send path', () => {
  assert.match(source, /sandboxTransport: true/)
  assert.doesNotMatch(source, /sendReminderNow|executeAutoSend|sendEmail|supabase\.functions\.invoke|fetch\(/)
  assert.match(source, /productionAllowed: false/)
})
