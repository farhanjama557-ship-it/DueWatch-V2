import test from 'node:test'
import assert from 'node:assert/strict'

import { initials } from '../src/lib/format.js'

test('initials ignore symbols and use the first two meaningful words', () => {
  assert.equal(initials('Marlow & Partners'), 'MP')
  assert.equal(initials('Cedar & Vine Interiors'), 'CV')
  assert.equal(initials('Northfield Logistics Group'), 'NL')
  assert.equal(initials('Meridian Design Co'), 'MD')
})

test('initials preserve the established single-word and empty-name behavior', () => {
  assert.equal(initials('Nova'), 'NO')
  assert.equal(initials('  '), '—')
  assert.equal(initials('&&'), '—')
})
