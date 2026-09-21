import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCashFlowReadModel } from '../src/lib/cashFlowReadModel.js'

const invoice = (overrides={}) => ({
  id:'i1',
  invoice_number:'INV-1',
  amount:1000,
  amount_paid:0,
  paid:false,
  due_date:'2026-09-28',
  currency:'USD',
  clients:{name:'Client A'},
  ...overrides,
})

test('confirmed promise moves promised portion to promise timing without double counting invoice balance', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice()],
    promises:[{
      id:'p1',invoice_id:'i1',status:'confirmed',promised_amount:600,promised_date:'2026-09-23',
      operational:{state:'due_soon'}
    }],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.scheduled30Amount,1000)
  assert.equal(model.committedPromiseAmount30,600)
  assert.equal(model.events.filter(e=>e.type==='confirmed_promise')[0].amount,600)
  assert.equal(model.events.filter(e=>e.type==='invoice_due')[0].amount,400)
})

test('past-due unresolved promise is exposure, never counted as future scheduled cash', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice({due_date:'2026-09-10'})],
    promises:[{
      id:'p1',invoice_id:'i1',status:'confirmed',promised_amount:700,promised_date:'2026-09-20',
      operational:{state:'past_due_unresolved'}
    }],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.pastDuePromiseExposure,700)
  assert.equal(model.scheduled30Amount,0)
  assert.equal(model.overdueExposure,1000)
})

test('cash read model declares unsupported prediction and outflow capabilities false', () => {
  const model=buildCashFlowReadModel({invoices:[],promises:[],asOf:new Date('2026-09-21T12:00:00Z')})
  assert.equal(model.capabilities.predictiveForecast,false)
  assert.equal(model.capabilities.operatingOutflows,false)
  assert.equal(model.capabilities.paymentProbability,false)
})

test('missing invoice currency is surfaced as data quality, never defaulted', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice({currency:null})],
    promises:[],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.dataQuality.missingCurrencyCount,1)
})

test('promise amount is capped at current invoice balance in the timing model', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice({amount:500})],
    promises:[{
      id:'p1',invoice_id:'i1',status:'confirmed',promised_amount:900,promised_date:'2026-09-23',
      operational:{state:'due_soon'}
    }],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.scheduled30Amount,500)
  assert.equal(model.committedPromiseAmount30,500)
})


test('partially fulfilled promise schedules only its unpaid remainder and never double counts', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice({amount:1000, amount_paid:200})],
    promises:[{
      id:'p1',
      invoice_id:'i1',
      status:'confirmed',
      promised_amount:600,
      promised_date:'2026-09-23',
      currency:'USD',
      operational:{state:'due_soon', fulfilledAmount:200},
    }],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.scheduled30Amount,800)
  assert.equal(model.committedPromiseAmount30,400)
  assert.equal(model.events.find((e)=>e.type==='confirmed_promise').amount,400)
  assert.equal(model.events.find((e)=>e.type==='invoice_due').amount,400)
})

test('mixed and unknown currencies never collapse into one numeric cash total', () => {
  const model=buildCashFlowReadModel({
    invoices:[
      invoice({id:'usd',amount:100,currency:'USD'}),
      invoice({id:'eur',amount:100,currency:'EUR'}),
      invoice({id:'unknown',amount:100,currency:null}),
    ],
    promises:[],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.scheduled30Amount,null)
  assert.equal(model.scheduled30Summary.knownCurrencyCount,2)
  assert.equal(model.scheduled30Summary.unknownCount,1)
  assert.deepEqual(
    model.scheduled30Summary.byCurrency.map((entry)=>[entry.currency,entry.amount]),
    [['EUR',100],['USD',100]]
  )
  assert.equal(model.dataQuality.missingCurrencyCount,1)
  assert.equal(model.dataQuality.mixedCurrencyTiming,true)
})

test('past-due promise exposure uses only the remaining attributable commitment', () => {
  const model=buildCashFlowReadModel({
    invoices:[invoice({amount:1000, amount_paid:200, due_date:'2026-09-10'})],
    promises:[{
      id:'p1',
      invoice_id:'i1',
      status:'confirmed',
      promised_amount:600,
      promised_date:'2026-09-20',
      currency:'USD',
      operational:{state:'past_due_unresolved', fulfilledAmount:200},
    }],
    asOf:new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(model.pastDuePromiseExposure,400)
})
