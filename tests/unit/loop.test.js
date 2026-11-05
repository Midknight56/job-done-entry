import { describe, it, expect } from 'vitest'
import { runTurn } from '../../src/agent/loop.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { devStubModel } from '../../src/agent/devstub.js'
import { SYSTEM_PROMPT } from '../../src/agent/prompt.js'
import { createTools } from '../../src/agent/tools.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const MARIA = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.'

it('returns waiting availability and defaults old jobs to any time', async () => {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  const { tools } = createTools(ws, { transcript: '', now: NOW })
  ws.jobs.find((j) => j.id === 'j5').free = [1, 3]
  expect((await tools.waiting_list()).jobs[0].free).toEqual([1, 3])
  delete ws.jobs.find((j) => j.id === 'j5').free
  expect((await tools.waiting_list()).jobs[0].free).toBe('any')
})

it('turns spoken waiting words into a proposal with no job or deposit until the tap', async () => {
  const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
  const before = structuredClone(ws)
  const text = 'Put Dave on the waiting list for a two hour shower job, mornings'
  const out = await runTurn(ws, text, { callModel: devStubModel(text), now: NOW })
  expect(out.proposal).toMatchObject({ kind: 'waiting', customerId: 'c2', customer: 'Dave Chen', summary: 'Shower job', hours: 2, free: 'mornings' })
  expect(ws).toEqual(before)
  expect(SYSTEM_PROMPT).toContain('"kind": "waiting"')
})

/** A fake model that answers from a list, recording what it was sent. */
function fakeModel(replies) {
  const seen = []
  const call = async (messages) => {
    seen.push(messages)
    const r = replies.shift()
    if (r === undefined) throw new Error('no more replies')
    return { text: typeof r === 'string' ? r : JSON.stringify(r), neurons: 26.8 }
  }
  return { call, seen }
}

const step1 = {
  calls: [
    { tool: 'find_customer', args: { name: 'Maria', place_hint: '14 Elm' } },
    { tool: 'price_lines', args: { lines: [{ kind: 'callout' }, { kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Kitchen tap', cost: 89 }] } },
  ],
}
const step2 = { final: { kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2', 'p3'], summary: 'Kitchen tap' } }

describe('the two step loop', () => {
  it('gives the Maria draft from the fake model\'s two steps', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([step1, step2])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal).toMatchObject({ kind: 'invoice', customerId: 'c1' })
    expect(out.proposal.priced.total).toBe('282.42')
    expect(out.proposal.reason).toBe('Priced from your rate card and what you said.')
    expect(out.proposal.priced.lines.map((l) => l.source)).toEqual(['rate card', 'rate card', 'you said 89'])
    expect(out.proposal.draftId).toMatch(/^d\d+$/)
    expect(ws.drafts[out.proposal.draftId]).toBeTruthy()
    expect(model.seen).toHaveLength(2)
    // The second step was given the tool results.
    expect(JSON.stringify(model.seen[1])).toContain('282.42')
    expect(out.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'tool', 'model', 'guard'])
  })

  it('retries malformed JSON once', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel(['this is not json', step1, step2])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal.kind).toBe('invoice')
    expect(model.seen).toHaveLength(3)
  })

  it('stops after a second malformed reply with a plain message', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel(['nope', 'still nope', step2])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal).toBe(null)
    expect(out.message).toBe('I did not catch that. Type it or try again.')
    expect(model.seen).toHaveLength(2)
  })

  it('a final that the guard drops gives no proposal and says why', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([step1, { final: { kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p7'] } }])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal).toBe(null)
    expect(out.steps.at(-1)).toMatchObject({ kind: 'guard', result: 'dropped: not backed by a tool result' })
  })

  it('never makes more than three model calls in a turn', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([step1, step1, step1, step1])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(model.seen.length).toBeLessThanOrEqual(3)
    expect(out.proposal).toBe(null)
  })

  it('an unknown tool is refused in its result, not run', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([{ calls: [{ tool: 'send_invoice', args: {} }] }, { final: { kind: 'answer', text: 'Done.', invoice_ids: [] } }])
    const out = await runTurn(ws, 'send it', { callModel: model.call, now: NOW })
    expect(JSON.stringify(model.seen[1])).toContain('unknown tool')
    expect(out.proposal).toMatchObject({ kind: 'answer', text: 'Done.' })
  })
})

describe('other turns', () => {
  it('a booking turn drafts a job in a found slot with a 50.00 deposit draft', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'find_slots', args: { duration_hours: 1, after: '2026-11-02', before: '2026-11-06' } }] },
      { final: { kind: 'booking', customer_id: 'c1', slot_id: 's2', summary: 'Bathroom tap' } },
    ])
    const out = await runTurn(ws, 'Book the bathroom tap for Maria next week', { callModel: model.call, now: NOW })
    expect(out.proposal).toMatchObject({ kind: 'booking', customerId: 'c1', deposit: '50.00' })
    expect(out.proposal.slot.label).toBe('Mon 2 Nov 9:00')
    expect(out.proposal.reason).toBe('One hour by default. First free time in the period you asked for. A 50.00 deposit holds it.')
    expect(ws.jobs.find((j) => j.id === out.proposal.jobId).state).toBe('draft')
  })

  it('"what am I owed" falls back to an answer built by code when the model text names a made up figure', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW - 15 * 86_400_000, reminders: 2 }
    const model = fakeModel([
      { calls: [{ tool: 'open_invoices', args: {} }] },
      { final: { kind: 'answer', text: 'You are owed 999.00.', invoice_ids: ['INV2-SAM'] } },
    ])
    const out = await runTurn(ws, 'What am I owed?', { callModel: model.call, now: NOW })
    expect(out.proposal.text).toBe('340.00 from Sam Okafor, 15 days late. 340.00 in all.')
    expect(out.proposal.invoiceIds).toEqual(['INV2-SAM'])
    expect(out.proposal.reason).toBe('Each figure is an open invoice.')
    expect(out.steps.at(-1).result).toMatch(/removed/)
  })

  it('replaces a grand total answer that omits an open invoice with the complete code written answer', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW, reminders: 0 }
    ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', kind: 'invoice', total: '282.42', due: '282.42', status: 'SENT', sentAt: NOW, reminders: 0 }
    ws.invoices['INV2-DEPOSIT'] = { id: 'INV2-DEPOSIT', customerId: 'c1', kind: 'deposit', total: '50.00', due: '50.00', status: 'SENT', sentAt: NOW, reminders: 0 }
    const model = fakeModel([
      { calls: [{ tool: 'open_invoices', args: {} }] },
      { final: { kind: 'answer', text: 'You are owed 340.00 by Sam Okafor and 282.42 by Maria Lopez. Total owed is 672.42.', invoice_ids: [] } },
    ])
    const out = await runTurn(ws, 'What am I owed?', { callModel: model.call, now: NOW })
    expect(out.proposal.text).toBe('340.00 from Sam Okafor. 282.42 from Maria Lopez. 50.00 from Maria Lopez. 672.42 in all.')
    expect(out.steps.at(-1).result).toMatch(/removed/)
  })

  it('calls an open invoice eight days old late and does not call one six days old late', async () => {
    for (const [age, expected] of [[8, '340.00 from Sam Okafor, 8 days late. 340.00 in all.'], [6, '340.00 from Sam Okafor. 340.00 in all.']]) {
      const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
      ws.invoices['INV2-SAM'] = { id: 'INV2-SAM', customerId: 'c3', kind: 'invoice', total: '340.00', due: '340.00', status: 'SENT', sentAt: NOW - age * 86_400_000, reminders: 0 }
      const model = fakeModel([
        { calls: [{ tool: 'open_invoices', args: {} }] },
        { final: { kind: 'answer', text: 'You are owed 999.00.', invoice_ids: ['INV2-SAM'] } },
      ])
      const out = await runTurn(ws, 'What am I owed?', { callModel: model.call, now: NOW })
      expect(out.proposal.text).toBe(expected)
    }
  })

  it('writes the cash reason from the customer and open invoice due', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', kind: 'invoice', total: '100.00', due: '100.00', status: 'SENT', sentAt: NOW, reminders: 0 }
    const model = fakeModel([
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'open_invoices', args: {} }] },
      { final: { kind: 'cash', invoice_id: 'INV2-MARIA', amount: '20.00' } },
    ])
    const out = await runTurn(ws, 'Maria paid 20 cash', { callModel: model.call, now: NOW })
    expect(out.proposal.reason).toBe("Matches Maria Lopez's open invoice for 100.00.")
  })

  it('explains standard reminder delivery and the separate draft', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    ws.invoices['INV2-MARIA'] = { id: 'INV2-MARIA', customerId: 'c1', kind: 'invoice', total: '100.00', due: '100.00', status: 'SENT', sentAt: NOW, reminders: 2 }
    const model = fakeModel([
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'open_invoices', args: {} }] },
      { final: { kind: 'reminder', invoice_id: 'INV2-MARIA', text: 'Please pay.' } },
    ])
    const out = await runTurn(ws, 'Remind Maria about her invoice', { callModel: model.call, now: NOW })
    expect(out.proposal.reason).toBe('PayPal sends its standard reminder. The draft is for you to send yourself.')
  })

  it('writes the new customer reason in code', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([
      { calls: [{ tool: 'find_customer', args: { name: 'New Person' } }] },
      { final: { kind: 'invoice', customer_id: 'new' } },
    ])
    const out = await runTurn(ws, 'New Person called about a job', { callModel: model.call, now: NOW })
    expect(out.proposal.reason).toBe('No customer by that name yet.')
  })
})

describe('faults seen with the live model on 23 Oct 2026', () => {
  it('a proposal sent without its final wrapper is accepted', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([step1, step2.final])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal.kind).toBe('invoice')
  })

  it('the call out is added from the rate card when labour was priced without it', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const noCallout = { calls: [step1.calls[0], { tool: 'price_lines', args: { lines: [{ kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Tap', cost: 89 }] } }] }
    const model = fakeModel([noCallout, { final: { kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2', 'p3'] } }])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: NOW })
    expect(out.proposal.priced.lines[0].name).toBe('Call out')
    expect(out.proposal.priced.total).toBe('282.42')
  })

  it('slot dates in a past year still find next week\'s slots, and today names its year', async () => {
    const ws = seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })
    const model = fakeModel([
      { calls: [{ tool: 'find_customer', args: { name: 'Maria' } }, { tool: 'find_slots', args: { duration_hours: 1, after: '2021-10-23', before: '2021-10-30' } }] },
      { final: { kind: 'booking', customer_id: 'c1', slot_id: 's1', summary: 'Bathroom tap' } },
    ])
    const out = await runTurn(ws, 'Book the bathroom tap for Maria next week.', { callModel: model.call, now: NOW })
    expect(out.proposal.kind).toBe('booking')
    expect(JSON.stringify(model.seen[0])).toContain('2026 (2026-10-28)')
  })
})

describe('which job an invoice is for', () => {
  it('requires confirmation even when a customer has a booked job later today', async () => {
    const early = Date.parse('2026-10-28T02:00:00Z') // 2 in the morning; Maria's job is at 13:00 today
    const ws = seedWorkspace({ id: 'w1', now: early, tzOffsetMinutes: 0 })
    const model = fakeModel([step1, step2])
    const out = await runTurn(ws, MARIA, { callModel: model.call, now: early })
    expect(out.proposal.jobId).toBeNull()
    expect(out.proposal.needsVisit).toBe(true)
  })
})
