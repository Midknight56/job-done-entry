import { describe, it, expect } from 'vitest'
import { devStubModel } from '../../src/agent/devstub.js'
import { runTurn, parseReply, reminderTemplate } from '../../src/agent/loop.js'
import { createTools, toneFor } from '../../src/agent/tools.js'
import { checkFinal, backedFigures } from '../../src/agent/guard.js'
import { replayModel, replayLines, remapInvoices } from '../../src/agent/replay.js'
import { SYSTEM_PROMPT, userMessage } from '../../src/agent/prompt.js'
import { seedWorkspace } from '../../src/state/workspace.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')

function workspace() {
  return seedWorkspace({ id: 'coverage', now: NOW, tzOffsetMinutes: 0 })
}

function model(replies) {
  return async () => {
    const reply = replies.shift()
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), neurons: 2, actual: 1 }
  }
}

describe('development model answers the supported demo lines', () => {
  async function output(text, results = []) {
    const call = devStubModel(text)
    await call([])
    return JSON.parse((await call([{ content: `Tool results: ${JSON.stringify(results)}` }])).text)
  }

  it('finds an invoice customer and prices callout labour and a spoken part', async () => {
    const call = devStubModel('Kitchen tap for Maria, hour and a half, the tap was $89')
    expect(JSON.parse((await call([])).text).calls.map((c) => c.tool)).toEqual(['find_customer', 'price_lines'])
    const result = JSON.parse((await call([{ content: '[]' }])).text)
    expect(result.final).toMatchObject({ kind: 'invoice', customer_id: 'new', summary: 'Kitchen tap' })
    const withLines = devStubModel('Tap for Maria')
    await withLines([])
    const final = await withLines([{ content: JSON.stringify([{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }, { tool: 'price_lines', result: { lines: [{ id: 'p9' }] } }]) }])
    expect(JSON.parse(final.text).final.line_ids).toEqual(['p9'])
  })

  it('uses spoken hours words for half hour and numeric labour durations', async () => {
    for (const [phrase, hours] of [['half an hour', 0.5], ['90 minutes', 1.5], ['ninety minutes', 1.5], ['2 hours', 2], ['an hour', 1]]) {
      const call = devStubModel(`Tap for Bob ${phrase}`)
      const first = JSON.parse((await call([])).text)
      expect(first.calls[1].args.lines[1].hours).toBe(hours)
    }
  })

  it('omits the part line when no part cost was spoken', async () => {
    const call = devStubModel('Tap for Bob, an hour')
    const first = JSON.parse((await call([])).text)
    expect(first.calls[1].args.lines.map((l) => l.kind)).toEqual(['callout', 'labour'])
  })

  it('looks up slots for a booking and finishes with a booking proposal', async () => {
    const call = devStubModel('Book a tap for Maria')
    const first = JSON.parse((await call([])).text)
    expect(first.calls.map((c) => c.tool)).toEqual(['find_customer', 'find_slots'])
    const final = await output('Book a tap for Maria', [{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }])
    expect(final.final).toMatchObject({ kind: 'booking', customer_id: 'c1', slot_id: 's1' })
  })

  it('checks the customer invoice before reminding and uses the cash amount said', async () => {
    const results = [
      { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
      { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'I1', customer_id: 'c1', due: '45.00' }] } },
    ]
    expect((await output('Remind Maria', results)).final).toMatchObject({ kind: 'reminder', invoice_id: 'I1' })
    expect((await output('Maria paid cash 20', results)).final).toMatchObject({ kind: 'cash', invoice_id: 'I1', amount: '20.00' })
  })

  it('answers owed totals and has a plain empty result when nothing is owed', async () => {
    expect((await output('What am I owed?', [{ tool: 'open_invoices', result: { invoices: [{ due: '10.00', customer: 'Sam', invoice_id: 'I1' }] } }])).final.text).toBe('10.00 from Sam.')
    expect((await output('What am I owed?', [])).final).toMatchObject({ kind: 'answer', text: '', invoice_ids: [] })
  })

  it('uses safe defaults when a reminder or cash request has no matching invoice', async () => {
    const remind = devStubModel('Remind')
    expect(JSON.parse((await remind([])).text).calls[0].args.name).toBe('')
    expect(JSON.parse((await remind([{ content: '[]' }])).text).final.text).toBe('Nothing is open for them.')
    const cash = devStubModel('cash')
    await cash([])
    expect(JSON.parse((await cash([{ content: '[]' }])).text).final.text).toBe('Nothing is open for them.')
    const cashFallback = devStubModel('cash')
    await cashFallback([])
    const cashResults = [{ tool: 'find_customer', result: { matches: [{ id: 'new' }] } }, { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'I', customer_id: 'new', due: '12.50' }] } }]
    const cashReply = await cashFallback([{ content: JSON.stringify(cashResults) }])
    expect(JSON.parse(cashReply.text)).toMatchObject({ final: { kind: 'cash', amount: '12.50' } })
  })

  it('treats an unrecognized request as an invoice and uses a new customer when no match exists', async () => {
    const unknown = devStubModel('Something for Zoe')
    expect(JSON.parse((await unknown([])).text).calls[0].args.name).toBe('zoe')
    expect((await output('Something for Zoe', [])).final).toMatchObject({ kind: 'invoice', customer_id: 'new' })
    const missing = devStubModel('Fix it')
    expect(JSON.parse((await missing([])).text).calls[0].args.name).toBe('')
    const noContent = devStubModel('anything')
    await noContent([])
    expect(JSON.parse((await noContent([{}])).text).final.kind).toBe('invoice')
  })
})

describe('tool results reflect customer, price, schedule and invoice state', () => {
  it('finds a customer by name or by a normalized place hint and reports invoice history', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', status: 'SENT', sentAt: NOW - 9 * 86400000, reminders: 1 }
    const { tools } = createTools(ws, { transcript: '', now: NOW })
    expect((await tools.find_customer({ name: 'Maria' })).matches[0]).toMatchObject({ id: 'c1', history: { invoices: 1, open: 1, late: 1, reminders_sent: 1 } })
    expect((await tools.find_customer({ place_hint: '14 Elm St.' })).matches[0].name).toBe('Maria Lopez')
  })

  it('refuses unsaid labour and part costs while inserting the callout for accepted labour', async () => {
    const { tools } = createTools(workspace(), { transcript: 'an hour and the valve was 20', now: NOW })
    const result = await tools.price_lines({ lines: [
      { kind: 'labour', hours: 2 }, { kind: 'part', description: 'wrong', cost: 21 },
      { kind: 'labour', hours: 1 }, { kind: 'part', description: 'valve', cost: 20 }, { kind: 'bad' },
    ] })
    expect(result.refused.map((r) => r.reason)).toEqual(['the time said was 1 hours', 'that cost was not said', 'unknown line kind'])
    expect(result.lines).toEqual([])
    expect(result.needsPartPrice).toBe(true)
    const confirmed = await tools.price_lines({ lines: [{ kind: 'labour', hours: 1 }, { kind: 'part', description: 'valve', cost: 20 }] })
    expect(confirmed.lines.map((line) => line.kind)).toEqual(['callout', 'labour', 'part'])
    const noTime = createTools(workspace(), { transcript: '', now: NOW })
    expect((await noTime.tools.price_lines({ lines: [{ kind: 'labour', hours: 1 }] })).lines).toHaveLength(0)
  })

  it('finds slots from the request even with invalid or expired model bounds', async () => {
    const { tools } = createTools(workspace(), { transcript: 'two hours next week', now: NOW })
    const valid = await tools.find_slots({ duration_hours: 2, after: '2026-11-02', before: '2026-11-06' })
    expect(valid.slots.length).toBeGreaterThan(0)
    const fallback = await tools.find_slots({ duration_hours: 1, after: 'bad date', before: '2020-01-01' })
    expect(fallback.slots.length).toBeGreaterThan(0)
    expect(fallback.slots.every((s) => Date.parse(s.end) - Date.parse(s.start) === 7200000)).toBe(true)
    expect(fallback.error).toBeUndefined()
  })

  it('reads live invoice amounts and retains stored status when the API read fails', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', kind: 'invoice', total: '40.00', due: '40.00', status: 'SENT', sentAt: NOW, reminders: 0 }
    const live = createTools(ws, { transcript: '', now: NOW, api: { request: async () => ({ ok: true, status: 200, json: { id: 'I1', status: 'PARTIALLY_PAID', amount: { value: '40.00' }, due_amount: { value: '15.00' }, payments: { paid_amount: { value: '25.00' } } } }) } })
    expect(await live.tools.open_invoices({})).toMatchObject({ total_due: '15.00', invoices: [{ due: '15.00' }] })
    const stale = createTools(ws, { transcript: '', now: NOW, api: { request: async () => { throw new Error('offline') } } })
    expect((await stale.tools.open_invoices({})).invoices[0].due).toBe('15.00')
  })

  it('returns waiting jobs and skips waiting ids without a matching job', async () => {
    const ws = workspace()
    ws.waiting.push('missing')
    const { tools } = createTools(ws, { transcript: '', now: NOW })
    expect(await tools.waiting_list()).toMatchObject({ jobs: [{ job_id: 'j5', customer: 'Priya Nair', summary: 'Leak under the sink', hours: 1 }] })
    expect((await tools.price_lines({ lines: 'not a list' })).lines).toEqual([])
    expect((await tools.find_customer({ name: 'nobody', place_hint: 'Elm' })).matches).toEqual([])
    expect((await tools.open_invoices({ customer_id: 'someone else' })).invoices).toEqual([])
  })
})

describe('turn loop builds proposals and reports model failures', () => {
  it('accepts a final reply before any tool calls and returns the checked answer', async () => {
    const out = await runTurn(workspace(), 'hello', { callModel: model([{ final: { kind: 'answer', text: 'Hello.', invoice_ids: [] } }]), now: NOW })
    expect(out.proposal).toMatchObject({ kind: 'answer', text: 'Hello.', invoiceIds: [] })
    expect(out.actual).toBe(1)
  })

  it('catches a thrown tool and passes its error back to the model', async () => {
    const ws = workspace()
    ws.customers = new Proxy([], { get(target, key) { if (key === 'filter') throw new Error('customer data failed'); return Reflect.get(target, key) } })
    const replies = [
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }] },
      { final: { kind: 'answer', text: 'Nothing owed.', invoice_ids: [] } },
    ]
    const failing = async (messages) => {
      if (messages.at(-1).content.startsWith('Tool results:')) expect(messages.at(-1).content).toContain('customer data failed')
      return model([replies.shift()])(messages)
    }
    const out = await runTurn(ws, 'what am I owed', { callModel: failing, now: NOW })
    expect(out.proposal.text).toBe('Nothing owed.')
    expect(out.steps.find((s) => s.kind === 'tool')).toMatchObject({ ok: false })
  })

  it('builds a confirmed new customer proposal when lookup finds nobody', async () => {
    const out = await runTurn(workspace(), 'Tap for Zoe', { callModel: model([
      { calls: [{ tool: 'find_customer', args: { name: 'Zoe' } }] },
      { final: { kind: 'invoice', customer_id: 'new', customer_name: 'Zoe' } },
    ]), now: NOW })
    expect(out.proposal).toEqual({ kind: 'new_customer', name: 'Zoe', reason: 'No customer by that name yet.' })
  })

  it('requires a visit choice instead of selecting the closest booked job', async () => {
    const ws = workspace()
    ws.jobs.push({ id: 'j-near', customerId: 'c1', summary: 'Near job', start: new Date(NOW + 1800000).toISOString(), end: new Date(NOW + 5400000).toISOString(), state: 'booked' })
    const out = await runTurn(ws, 'Tap for Maria, an hour', { callModel: model([
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'price_lines', args: { lines: [{ kind: 'callout' }, { kind: 'labour', hours: 1 }] } }] },
      { final: { kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2'] } },
    ]), now: NOW })
    expect(out.proposal.jobId).toBeNull()
    expect(out.proposal.needsVisit).toBe(true)
    expect(ws.drafts[out.proposal.draftId].jobId).toBeUndefined()
  })

  it('builds an invoice without a related job using the generic job summary', async () => {
    const out = await runTurn(workspace(), 'Tap for Priya, an hour', { callModel: model([
      { calls: [{ tool: 'find_customer', args: { name: 'Priya' } }, { tool: 'price_lines', args: { lines: [{ kind: 'labour', hours: 1 }] } }] },
      { final: { kind: 'invoice', customer_id: 'c4', line_ids: ['p1', 'p2'] } },
    ]), now: NOW })
    expect(out.proposal).toMatchObject({ kind: 'invoice', jobId: null, summary: 'Job' })
  })

  it('builds cash and reminder proposals with each reminder tone template', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c1', kind: 'invoice', due: '50.00', total: '50.00', status: 'SENT', reminders: 0 }
    const calls = [{ tool: 'open_invoices', args: {} }]
    const cash = await runTurn(ws, 'Maria paid 20', { callModel: model([
      { calls }, { final: { kind: 'cash', invoice_id: 'I1', amount: '20' } },
    ]), now: NOW })
    expect(cash.proposal).toMatchObject({ kind: 'cash', invoiceId: 'I1', amount: '20.00', due: '50.00', customer: 'Maria Lopez' })
    for (const [reminders, tone] of [[0, 'friendly'], [1, 'polite'], [2, 'firm']]) {
      ws.invoices.I1.reminders = reminders
      const reminder = await runTurn(ws, 'remind Maria', { callModel: model([
        { calls }, { final: { kind: 'reminder', invoice_id: 'I1', text: '' } },
      ]), now: NOW })
      expect(reminder.proposal.tone).toBe(tone)
      expect(reminder.proposal.text).toContain('Maria')
    }
    expect(reminderTemplate('friendly', null, '')).toContain('Hi there.')
    expect(toneFor(0)).toBe('friendly')
  })

  it('uses code generated owed text when model text is empty, with and without late invoices', async () => {
    const ws = workspace()
    ws.invoices.I1 = { id: 'I1', customerId: 'c3', kind: 'invoice', due: '25.00', total: '25.00', status: 'SENT', sentAt: NOW - 9 * 86400000, reminders: 0 }
    const one = await runTurn(ws, 'owed', { callModel: model([
      { calls: [{ tool: 'open_invoices', args: {} }] }, { final: { kind: 'answer', text: '', invoice_ids: [] } },
    ]), now: NOW })
    expect(one.proposal.text).toBe('25.00 from Sam Okafor, 9 days late. 25.00 in all.')
    ws.invoices.I1.status = 'PAID'
    const none = await runTurn(ws, 'owed', { callModel: model([
      { calls: [{ tool: 'open_invoices', args: {} }] }, { final: { kind: 'answer', text: '', invoice_ids: [] } },
    ]), now: NOW })
    expect(none.proposal.text).toBe('Nothing is owed right now.')
  })

  it('retries an unrecognized calls shape and stops at the maximum model call count', async () => {
    expect(parseReply('{"calls":[]}')).toBe(null)
    const ws = workspace()
    const retries = await runTurn(ws, 'hello', { callModel: model(['{}', '{"calls":[]}']), now: NOW })
    expect(retries.message).toBe('I did not catch that. Type it or try again.')
    expect(retries.outputs).toHaveLength(2)
    expect(retries.steps).toHaveLength(2)
  })
})

describe('guard refuses unsupported proposals and filters unsupported claims', () => {
  const ctx = { results: [], transcript: '' }

  it('refuses missing proposals and invoice details without supporting tool results', () => {
    expect(checkFinal(null, ctx).reason).toBe('no proposal')
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1'] }, ctx).reason).toBe('not backed by a tool result')
    const found = { results: [{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }], transcript: '' }
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: [] }, found).reason).toBe('not backed by a tool result')
    expect(checkFinal({ kind: 'invoice', customer_id: 'new', customer_name: 'Z'.repeat(70) }, found).proposal.name).toHaveLength(60)
  })

  it('refuses cash without an invoice, a zero amount and unbacked reminder ids', () => {
    expect(checkFinal({ kind: 'cash', invoice_id: 'I', amount: 1 }, ctx).ok).toBe(false)
    const invoices = { results: [{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'I', due: '10' }] } }], transcript: 'paid 0' }
    expect(checkFinal({ kind: 'cash', invoice_id: 'I', amount: 0 }, invoices).ok).toBe(false)
    expect(checkFinal({ kind: 'reminder', invoice_id: 'missing', text: 'hello' }, invoices).ok).toBe(false)
  })

  it('keeps valid figures as backed values and refuses arbitrary proposal kinds', () => {
    expect(backedFigures({ results: [{ tool: 'x', result: { amount: 12.5, details: ['8'] } }], transcript: 'paid 7' }).size).toBeGreaterThan(0)
    expect(checkFinal({ kind: 'refund' }, ctx).reason).toBe('not a proposal this app makes')
  })

  it('turns an unknown booking customer into a confirmation and handles omitted answer ids', () => {
    const searched = { results: [{ tool: 'find_customer', result: { matches: [] } }], transcript: '' }
    expect(checkFinal({ kind: 'booking', customer_id: '', customer_name: 'Pat' }, searched).proposal).toEqual({ kind: 'new_customer', name: 'Pat' })
    expect(checkFinal({ kind: 'answer', text: 'No amount is owed.' }, ctx).proposal.invoice_ids).toEqual([])
  })
})

describe('replay handles missing samples and malformed recorded tool output', () => {
  it('returns no model for an unknown line and exposes the recorded lines', () => {
    expect(replayModel('unrecorded phrase')).toBe(null)
    expect(replayLines().length).toBeGreaterThan(0)
  })

  it('replays a known line and returns an empty output after its sample replies run out', async () => {
    const known = replayLines()[0]
    const standIn = replayModel(known)
    expect(standIn).toBeTypeOf('function')
    expect((await standIn([{ content: 'The tradesperson said' }])).neurons).toBe(0)
  })

  it('remaps invoices without a customer match and keeps an id with no matching result', () => {
    const id = 'INV2-AAAA-BBBB-CCCC-DDDD'
    const messages = [{ content: `Tool results: ${JSON.stringify([{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-NEW1-NEW2-NEW3-NEW4', customer_id: 'c2' }] } }] )}` }]
    expect(remapInvoices(id, messages)).toBe('INV2-NEW1-NEW2-NEW3-NEW4')
    expect(remapInvoices(id, [{ content: 'Tool results: not json [' }])).toBe(id)
    expect(remapInvoices(id, [{ content: 'Tool results: []' }])).toBe(id)
  })
})

describe('prompt text sets the model contract and preserves the transcript', () => {
  it('describes the available read only tools and safely quotes user text', () => {
    expect(SYSTEM_PROMPT).toContain('waiting_list')
    expect(SYSTEM_PROMPT).toContain('The lines always start with {"kind": "callout"}.')
    expect(userMessage({ business: 'Plumbing', today: 'Wednesday 2026', transcript: 'I said "hello"' })).toContain('The tradesperson said: "I said \'hello\'"')
  })
})
