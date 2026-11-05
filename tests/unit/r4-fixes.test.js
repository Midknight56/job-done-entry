import { expect, it } from 'vitest'
import { seedWorkspace } from '../../src/state/workspace.js'
import { handleWebhook } from '../../src/paypal/webhooks.js'
import { resetTokenCache } from '../../src/paypal/token.js'
import { memoryKV } from './memory-kv.js'
import { fakePayPal } from './fake-paypal.js'
import { spawnSync } from 'node:child_process'
import { durationHours, costWasSaid } from '../../src/pricing/words.js'
import { createTools } from '../../src/agent/tools.js'
import { checkFinal } from '../../src/agent/guard.js'
import { runTurn } from '../../src/agent/loop.js'
import { applyStatus } from '../../src/state/money.js'

const now = Date.parse('2026-11-05T14:00:00Z')
const workspace = () => seedWorkspace({ id: 'repairs4', now, tzOffsetMinutes: 0 })

it('R4 item 5 applies both name and address constraints', async () => {
  const ws = workspace()
  ws.customers.push({ id: 'other', name: 'Maria Santos', address: '99 Oak Road' })
  const { tools } = createTools(ws, { transcript: 'Invoice Maria at 14 Elm for one hour', now })
  const found = await tools.find_customer({ name: 'Maria', place_hint: '14 Elm' })
  expect(found.matches.map(c => c.id)).toEqual(['c1'])
  expect((await tools.find_customer({ name: 'Maria Lopez', place_hint: '99 Oak' })).matches).toEqual([])
  expect((await tools.find_customer({ name: 'Maria Santos' })).matches.map(c => c.id)).toEqual(['other'])
  expect((await tools.find_customer({ name: 'Maria', place_hint: '4 Elm' })).matches).toEqual([])
  const wrong = checkFinal({ kind: 'invoice', customer_id: 'other', line_ids: ['call'] }, { transcript: 'Invoice Maria at 14 Elm', results: [
    { tool: 'find_customer', result: found }, { tool: 'price_lines', result: { lines: [{ id: 'call', kind: 'callout' }] } },
  ] })
  expect(wrong.ok).toBe(false)
})

it.each(['invoice', 'booking', 'cash', 'reminder'])('R4 item 5 blocks ambiguous customer for %s', (kind) => {
  const final = { kind, customer_id: 'other', line_ids: ['call'], slot_id: 'slot', invoice_id: 'INV', amount: '14.00', text: 'Please pay.' }
  const results = [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }, { id: 'other' }] } },
    { tool: 'price_lines', result: { lines: [{ id: 'call', kind: 'callout' }] } },
    { tool: 'find_slots', result: { slots: [{ id: 'slot', start: '2026-11-06T08:00:00Z', end: '2026-11-06T09:00:00Z' }] } },
    { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV', customer_id: 'other', due: '14.00' }] } },
  ]
  expect(checkFinal(final, { transcript: 'Maria paid cash 14', results }).ok).toBe(false)
})

it('R4 item 5 requires clarification and creates no draft for an ambiguous name', async () => {
  const ws = workspace()
  ws.customers.push({ id: 'other', name: 'Maria Santos', address: '99 Oak Road' })
  const before = JSON.stringify(ws.drafts)
  const replies = [
    { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'price_lines', args: { lines: [{ kind: 'labour', hours: 1 }] } }] },
    { final: { kind: 'invoice', customer_id: 'other', line_ids: ['p1', 'p2'] } },
  ]
  const result = await runTurn(ws, 'Invoice Maria for one hour', { now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }) })
  expect(result.proposal).toBe(null)
  expect(result.message).toContain('Which customer? Say the full name and address.')
  expect(result.message).toContain('Maria Santos')
  expect(JSON.stringify(ws.drafts)).toBe(before)
})

it.each(['at 14 Elm for one hour', 'for fourteen minutes', 'on November 14 for one hour', 'with 14 washers for one hour', 'the washer was 14 minutes old'])('R4 item 4 rejects unrelated number %s', async (said) => {
  const transcript = `Invoice Maria ${said}`
  expect(costWasSaid(transcript, 14)).toBe(false)
  const { tools } = createTools(workspace(), { transcript, now })
  const priced = await tools.price_lines({ lines: [{ kind: 'part', description: 'Washer', cost: 14 }] })
  expect(priced.lines).toEqual([])
  const result = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['part'] }, { transcript, results: [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
    { tool: 'price_lines', result: { lines: [{ id: 'part', kind: 'part', description: 'Washer', cost: 14 }] } },
  ] })
  expect(result.ok).toBe(false)
})

it('R4 item 4 associates the price with the named part', async () => {
  expect(costWasSaid('the washer cost fourteen dollars', 14, 'Washer')).toBe(true)
  expect(costWasSaid('the tap was 14', 14, 'Washer')).toBe(false)
  const transcript = 'Invoice Maria at 14 Elm for one hour'
  const replies = [{ calls: [{ tool: 'price_lines', args: { lines: [{ kind: 'part', description: 'Washer', cost: 14 }] } }] }]
  const result = await runTurn(workspace(), transcript, { now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }) })
  expect(result.proposal).toBe(null)
  expect(result.message).toBe('What did the part cost? Say the part name and price.')
})

it('R4 item 2 regression module parses', () => {
  const result = spawnSync(process.execPath, ['--check', 'tests/unit/r3-fixes.test.js'], { encoding: 'utf8' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})

it.each(['one hour and thirty minutes', '1 hour 30 minutes', 'one hour and twenty minutes'])('R4 item 3 combines complete duration %s before rounding', (said) => {
  expect(durationHours(said, 30)).toBe(1.5)
})

it('R4 item 3 shares compound duration across pricing booking and validation', async () => {
  const transcript = 'Invoice Maria for one hour and thirty minutes tomorrow'
  const { tools } = createTools(workspace(), { transcript, now })
  const priced = await tools.price_lines({ lines: [{ kind: 'labour', hours: 1.5 }] })
  expect(priced.total).toBe('186.30')
  const slots = await tools.find_slots({ duration_hours: 1 })
  expect(slots.slots.length).toBeGreaterThan(0)
  expect(slots.slots.every(s => Date.parse(s.end) - Date.parse(s.start) === 5400000)).toBe(true)
  const results = [{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }, { tool: 'price_lines', result: priced }, { tool: 'find_slots', result: slots }]
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: priced.lines.map(l => l.id) }, { transcript, results }).ok).toBe(true)
  expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: slots.slots[0].id }, { transcript, results }).ok).toBe(true)
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['short'] }, { transcript, results: [results[0], { tool: 'price_lines', result: { lines: [{ id: 'short', kind: 'labour', quantity: '1' }] } }] }).ok).toBe(false)
  expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 'short' }, { transcript, results: [results[0], { tool: 'find_slots', result: { slots: [{ id: 'short', start: '2026-11-06T08:00:00Z', end: '2026-11-06T09:00:00Z' }] } }] }).ok).toBe(false)
})

it.each(['one hour or thirty minutes', 'one hour today and two hours tomorrow', 'one hour and a bit'])('R4 item 3 asks about uncertain duration %s', async (said) => {
  const transcript = `Book Maria for ${said} tomorrow`
  expect(durationHours(transcript, 15)).toBe(null)
  const { tools } = createTools(workspace(), { transcript, now })
  expect(await tools.find_slots({})).toMatchObject({ slots: [], needsDuration: true })
  const replies = [{ calls: [{ tool: 'find_slots', args: {} }] }, { final: { kind: 'answer', text: 'Done.' } }]
  const result = await runTurn(workspace(), transcript, { now, callModel: async () => ({ text: JSON.stringify(replies.shift()), neurons: 0 }) })
  expect(result.proposal).toBe(null)
  expect(result.message).toBe('How long is the visit? Say one length in hours and minutes.')
  const priced = await tools.price_lines({ lines: [{ kind: 'callout' }] })
  expect(priced).toMatchObject({ lines: [], needsDuration: true })
  expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['call'] }, { transcript, results: [
    { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }, { tool: 'price_lines', result: { lines: [{ id: 'call', kind: 'callout' }] } },
  ] }).ok).toBe(false)
})

it.each([false, true])('R4 item 1 preserves cumulative payments with reversed delivery %s', async (reverse) => {
  resetTokenCache()
  const ws = workspace(), kv = memoryKV()
  ws.invoices.INV = { id: 'INV', customerId: 'c1', status: 'SENT', total: '100.00', due: '100.00' }
  await kv.put(`ws:${ws.id}`, JSON.stringify(ws)); await kv.put('inv:INV', ws.id)
  const env = { JOBDONE: kv, PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', PAYPAL_WEBHOOK_ID: 'test' }
  const pp = fakePayPal({ 'POST /v1/notifications/verify-webhook-signature': [0, 1].map(() => ({ status: 200, body: { verification_status: 'SUCCESS' } })) })
  const headers = Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'].map(name => [name, 'test']))
  for (const paid of reverse ? [60, 30] : [30, 60]) {
    const event = { id: `payment${paid}`, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV', status: 'PARTIALLY_PAID', due_amount: { value: `${100 - paid}.00` }, payments: { paid_amount: { value: `${paid}.00` } } } } }
    expect((await handleWebhook(new Request('https://job-done.test/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) }), env, { waitUntil() {} }, { fetch: pp.fetch, now: () => now })).status).toBe(200)
  }
  const saved = JSON.parse(await kv.get(`ws:${ws.id}`))
  expect(saved.invoices.INV).toMatchObject({ paid: '60.00', due: '40.00' })
  expect(saved.notices.some(n => /paid -/.test(n.text))).toBe(false)
})

it('R4 item 1 keeps refunds separate from cumulative payment rejection', () => {
  const ws = workspace()
  ws.invoices.INV = { id: 'INV', status: 'PARTIALLY_PAID', paid: '60.00', due: '40.00', total: '100.00' }
  expect(applyStatus(ws, 'INV', 'PARTIALLY_REFUNDED', now, { paid: '60.00', due: '40.00', refunded: '10.00' })).toBe(true)
  expect(ws.invoices.INV.refunded).toBe('10.00')
})
