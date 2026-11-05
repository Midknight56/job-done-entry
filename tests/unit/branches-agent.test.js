import { describe, it, expect } from 'vitest'
import { checkFinal, scrubText } from '../../src/agent/guard.js'
import { parseReply, runTurn } from '../../src/agent/loop.js'
import { normalize, replayLines, replayModel, remapInvoices } from '../../src/agent/replay.js'
import { createTools } from '../../src/agent/tools.js'
import { seedWorkspace } from '../../src/state/workspace.js'

const now = Date.parse('2026-10-28T14:00:00Z')

describe('guard handles missing values and invalid proposal details safely', () => {
  const ctx = { results: [], transcript: '' }

  it('normalizes falsey text and removes only sentences with unsupported figures', () => {
    expect(scrubText(null, ctx)).toEqual({ text: '', removed: [] })
    expect(scrubText('No figures here. 99 is unsupported.', ctx)).toEqual({ text: 'No figures here.', removed: ['99 is unsupported.'] })
    expect(scrubText('One visit, 4 hours, and 1 call.', ctx).text).toBe('One visit, 4 hours, and 1 call.')
  })

  it('ignores failed and empty tool results while converting a searched new customer', () => {
    const results = [
      { tool: 'find_customer', result: { error: 'offline', matches: [{ id: 'bad' }] } },
      { tool: 'find_customer', result: { matches: [] } },
      { tool: 'find_customer', result: {} },
      { tool: 'price_lines', result: { error: 'offline', lines: [{ id: 'bad' }] } },
      { tool: 'price_lines', result: {} },
      { tool: 'find_slots', result: {} },
      { tool: 'open_invoices', result: {} },
    ]
    expect(checkFinal({ kind: 'invoice', customer_id: 'new', customer_name: '' }, { results, transcript: '' }).proposal).toEqual({ kind: 'new_customer', name: 'New customer' })
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['bad'] }, { results, transcript: '' }).ok).toBe(false)
  })

  it('requires spoken part costs and labour duration before accepting priced lines', () => {
    const results = [{ tool: 'price_lines', result: { lines: [
      { id: 'part', kind: 'part', unitAmount: '20.00' },
      { id: 'labour', kind: 'labour', quantity: '1' },
      { id: 'callout', kind: 'callout' },
    ] } }, { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }]
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['part'] }, { results, transcript: 'an hour' }).reason).toContain('part cost')
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['labour'] }, { results, transcript: '' }).reason).toContain('hours were not said')
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['callout'], summary: '' }, { results, transcript: '' }).proposal.summary).toBe('')
    expect(checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['callout'], note: 'Hello' }, { results, transcript: '' }).proposal.note).toBe('Hello')
  })

  it('uses defaults for booking and filters cash, reminder and answer values', () => {
    const results = [
      { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } },
      { tool: 'find_slots', result: { slots: [{ id: 's1', start: '2026-11-06T08:00:00Z', end: '2026-11-06T09:00:00Z' }] } },
      { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'I1', due: '10.00' }] } },
    ]
    expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's1', summary: '' }, { results, transcript: '' }).proposal.summary).toBe('Job')
    expect(checkFinal({ kind: 'cash', invoice_id: 'I1', amount: 11 }, { results, transcript: 'paid 11' }).ok).toBe(false)
    expect(checkFinal({ kind: 'cash', invoice_id: 'I1', amount: 2 }, { results, transcript: '' }).reason).toContain('was not said')
    expect(checkFinal({ kind: 'reminder', invoice_id: 'I1', text: 'hello' }, { results, transcript: '' }).removed).toEqual([])
    expect(checkFinal({ kind: 'answer', text: '', invoice_ids: 'I1' }, { results, transcript: '' }).proposal.invoice_ids).toEqual([])
  })
})

describe('agent helpers handle empty model and replay data', () => {
  it('rejects incomplete JSON and accepts a final object with extra surrounding text', () => {
    expect(parseReply('nothing here')).toBe(null)
    expect(parseReply('{"final":null}')).toBe(null)
    expect(parseReply('before {"kind":"answer"} after')).toEqual({ final: { kind: 'answer' } })
  })

  it('treats falsey model counters as zero and returns a clean message when no calls are returned', async () => {
    const ws = seedWorkspace({ id: 'branches', now, tzOffsetMinutes: 0 })
    const out = await runTurn(ws, 'hello', { now, callModel: async () => ({ text: 'not json', neurons: 0, actual: 0 }) })
    expect(out.proposal).toBe(null)
    expect(out.neurons).toBe(0)
    expect(out.actual).toBe(0)
  })

  it('normalizes empty text and handles missing recordings and invoice remap data', async () => {
    expect(normalize(null)).toBe('')
    expect(replayLines().length).toBeGreaterThan(0)
    expect(replayModel('')).toBe(null)
    expect(remapInvoices('ordinary answer', [])).toBe('ordinary answer')
    const id = 'INV2-AAAA-BBBB-CCCC-DDDD'
    expect(remapInvoices(id, [{ content: `Tool results: ${JSON.stringify([{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-NEW1-NEW2-NEW3-NEW4' }] } }] )}` }])).toBe('INV2-NEW1-NEW2-NEW3-NEW4')
    const known = replayModel(replayLines()[0])
    for (let i = 0; i < 5; i++) await known([])
    expect((await known([])).text).toBe('')
    expect(remapInvoices(id, [{ content: 'Tool results: []' }])).toBe(id)
  })
})

describe('tools use safe defaults for optional search and price inputs', () => {
  it('returns no matches for missing names and handles omitted lines and bounds', async () => {
    const ws = seedWorkspace({ id: 'branches', now, tzOffsetMinutes: 0 })
    const { tools } = createTools(ws, { transcript: '', now })
    expect((await tools.find_customer({})).matches).toEqual([])
    expect((await tools.price_lines({})).lines).toEqual([])
    expect(await tools.find_slots({})).toEqual({ slots: [], needsDate: true })
    expect((await tools.open_invoices({})).total_due).toBe('0.00')
  })
})
