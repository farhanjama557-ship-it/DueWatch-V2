import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pulse=await readFile(new URL('../src/overhaul/LockedPulse.jsx',import.meta.url),'utf8')

test('Pulse currentness is refresh-based and does not claim Supabase Realtime',()=>{
  assert.match(pulse,/Current Monitor/)
  assert.match(pulse,/Current data/)
  assert.doesNotMatch(pulse,/Live Monitor/)
  assert.doesNotMatch(pulse,/Live mode/)
  assert.match(pulse,/setInterval\(refreshCurrentData, 60000\)/)
})

test('Pulse reaction state machine is driven by a changed real event id',()=>{
  assert.match(pulse,/const newestId = events\[0\]\?\.id/)
  assert.match(pulse,/observedEventRef\.current === newestId/)
  for(const state of ['observing','processing','reacting','attention','settle','resting']){
    assert.ok(pulse.includes(`'${state}'`),`missing Pulse state ${state}`)
  }
})

test('Pulse does not run a decorative animation loop',()=>{
  assert.doesNotMatch(pulse,/requestAnimationFrame/)
  assert.doesNotMatch(pulse,/setInterval\([^\n]*setPulseState/)
})
