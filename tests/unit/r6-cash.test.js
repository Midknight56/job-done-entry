import { expect, it } from 'vitest'
import { cashAmountWasSaid } from '../../src/pricing/words.js'
import { runTurn } from '../../src/agent/loop.js'
import { seedWorkspace } from '../../src/state/workspace.js'

it('R6 item 1 asks for cash amount when only an address number was said', async () => {
  const now = Date.parse('2026-11-05T14:00:00Z')
  const ws = seedWorkspace({ id: 'cash6', now, tzOffsetMinutes: 0 })
  ws.invoices.CASH6 = { id: 'CASH6', customerId: 'c2', kind: 'invoice', status: 'SENT', total: '108.00', due: '108.00', sentAt: now }
  const before = structuredClone(ws)
  const replies = [
    { calls: [{ tool: 'find_customer', args: { name: 'Dave', place_hint: '3 Harbour Road' } }, { tool: 'open_invoices', args: {} }] },
    { final: { kind: 'cash', invoice_id: 'CASH6', amount: '3.00' } },
  ]
  const out = await runTurn(ws, 'Dave at 3 Harbour Road paid cash.', {
    now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }),
  })
  expect(out.proposal).toBeNull()
  expect(out.message).toBe('How much cash was paid? Say one amount.')
  expect(ws).toEqual(before)
})

it.each([
  ['Dave paid cash, 108.', 108], ['Maria paid 20 cash', 20],
  ['Dave paid one hundred and eight dollars in cash.', 108],
  ['Received $42.50 in cash from Dave.', 42.5], ['Cash payment of 20.', 20],
  ['Dave gave me 20 in cash.', 20], ['20 dollars cash from Dave.', 20],
])('R6 item 1 accepts explicit payment: %s', (text, amount) => {
  expect(cashAmountWasSaid(text, amount)).toBe(true)
})

it.each([
  ['Dave at 3 Harbour Road paid cash.', 3], ['Invoice 108. Dave paid cash.', 108],
  ['Dave paid cash after 3 hours.', 3], ['Dave paid 3 Harbour Road a visit in cash.', 3],
  ['Dave paid cash, 20 or 30.', 20], ['Dave paid 20 cash and paid 30 cash.', 20],
  ['Dave paid minus twenty cash.', 20], ['Dave paid -20 cash.', 20],
  ['Dave paid about 20 cash.', 20], ['Dave paid cash, 20.50.', 20],
  ['Dave has not paid 20 cash.', 20], ['Dave never paid 20 cash.', 20],
  ['Dave will pay 20 cash tomorrow.', 20], ['Dave at 3 Harbour Road paid cash, 108.', 3],
])('R6 item 1 rejects missing or uncertain payment: %s', (text, amount) => {
  expect(cashAmountWasSaid(text, amount)).toBe(false)
})
