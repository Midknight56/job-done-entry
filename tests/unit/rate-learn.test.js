// The rate card that learns. When the tradesperson says a call out or labour rate that differs from the card ("call
// out is 60 now"), the card shows a one tap change; the tap changes the card, prices the open draft again, and every
// later line from that rate says where it came from ("you said 60 on 28 Oct"). Code reads the rate from the words,
// never from the model, so a free turn costs nothing more and the model cannot set a price.
import { describe, it, expect } from 'vitest'
import { ratesSaid, offerRates, acceptRate } from '../../src/flows/rates.js'
import { priceLines } from '../../src/pricing/ratecard.js'
import { runTurn } from '../../src/agent/loop.js'
import { seedWorkspace } from '../../src/state/workspace.js'

const NOW = Date.parse('2026-10-28T14:00:00Z')
const SAID = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, call out is 60 now.'
const fresh = () => seedWorkspace({ id: 'w1', now: NOW, tzOffsetMinutes: 0 })

function fakeModel(replies) {
  return async () => {
    const r = replies.shift()
    if (r === undefined) throw new Error('no more replies')
    return { text: typeof r === 'string' ? r : JSON.stringify(r), neurons: 0 }
  }
}
const step1 = { calls: [
  { tool: 'find_customer', args: { name: 'Maria', place_hint: '14 Elm' } },
  { tool: 'price_lines', args: { lines: [{ kind: 'callout' }, { kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Kitchen tap', cost: 89 }] } },
] }
const step2 = { final: { kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2', 'p3'], summary: 'Kitchen tap' } }

describe('rates said in the words', () => {
  it('reads a call out or labour rate said as digits or words', () => {
    expect(ratesSaid(SAID)).toEqual([{ field: 'callout', value: '60.00', said: '60' }])
    expect(ratesSaid("callout's sixty five from today")).toEqual([{ field: 'callout', value: '65.00', said: '65' }])
    expect(ratesSaid('Labour is 95 an hour from now on.')).toEqual([{ field: 'labourPerHour', value: '95.00', said: '95' }])
    expect(ratesSaid('I charge ninety an hour now')).toEqual([{ field: 'labourPerHour', value: '90.00', said: '90' }])
    expect(ratesSaid('call out 60, labour 92.50')).toEqual([{ field: 'callout', value: '60.00', said: '60' }, { field: 'labourPerHour', value: '92.50', said: '92.50' }])
  })

  it('a time, a duration, no number or a silly number is not a rate', () => {
    for (const text of ['call out at 10 am for Ann', 'call out at 10:30', 'no call out for Ann, two hours', 'call out was waived', 'two hours of labour', 'labour 3 hours', 'call out is 9', 'labour is 5000 an hour', 'call out minus 20']) {
      expect(ratesSaid(text), text).toEqual([])
    }
  })

  it('the last of two says of one rate wins', () => {
    expect(ratesSaid('call out is 55, no, call out is 60')).toEqual([{ field: 'callout', value: '60.00', said: '60' }])
  })
})

describe('the one tap offer', () => {
  it('is made only when the rate differs from the card, and remembers the draft', () => {
    const ws = fresh()
    expect(offerRates(ws, 'call out is 45', NOW)).toEqual([])
    const [offer] = offerRates(ws, SAID, NOW, 'd11')
    expect(offer).toMatchObject({ field: 'callout', label: 'Call out', from: '45.00', value: '60.00', said: '60', on: '28 Oct', draftId: 'd11' })
    expect(ws.rateOffers[offer.id]).toMatchObject({ field: 'callout', value: '60.00' })
  })

  it('keeps at most 10 offers in the workspace', () => {
    const ws = fresh()
    for (let i = 0; i < 14; i++) offerRates(ws, `call out is ${50 + i}`, NOW + i)
    expect(Object.keys(ws.rateOffers)).toHaveLength(10)
  })
})

describe('the tap', () => {
  it('changes the card, prices the open draft again and names the source', () => {
    const ws = fresh()
    const priced = priceLines([{ kind: 'callout' }, { kind: 'labour', hours: 1.5 }, { kind: 'part', description: 'Kitchen tap', cost: 89 }], ws.settings.rateCard)
    ws.drafts.d11 = { id: 'd11', kind: 'invoice', customerId: 'c1', priced, summary: 'Kitchen tap' }
    const [offer] = offerRates(ws, SAID, NOW, 'd11')
    const out = acceptRate(ws, offer.id)
    expect(ws.settings.rateCard.callout).toBe('60.00')
    expect(ws.settings.rateCard.learned.callout).toEqual({ said: '60', on: '28 Oct' })
    expect(out.draftId).toBe('d11')
    expect(out.priced.lines.map((l) => [l.name, l.amount, l.source])).toEqual([
      ['Call out', '60.00', 'you said 60 on 28 Oct'], ['Labour', '127.50', 'rate card'], ['Kitchen tap', '89.00', 'you said 89'],
    ])
    // 60 + 127.50 + 89 = 276.50, plus 8% tax 22.12.
    expect(out.priced.total).toBe('298.62')
    expect(ws.drafts.d11.priced.total).toBe('298.62')
    // The next draft priced from the card says the same.
    expect(priceLines([{ kind: 'callout' }], ws.settings.rateCard).lines[0].source).toBe('you said 60 on 28 Oct')
  })

  it('a second tap changes nothing more; a sent draft is not priced again; an unknown offer is a 404', () => {
    const ws = fresh()
    const priced = priceLines([{ kind: 'callout' }], ws.settings.rateCard)
    ws.drafts.d11 = { id: 'd11', kind: 'invoice', customerId: 'c1', priced, summary: 'Tap', invoiceId: 'INV2-X' }
    const [offer] = offerRates(ws, 'call out is 60 now', NOW, 'd11')
    expect(acceptRate(ws, offer.id).priced).toBeUndefined()
    expect(ws.drafts.d11.priced.total).toBe(priced.total)
    expect(() => acceptRate(ws, offer.id)).not.toThrow()
    expect(ws.settings.rateCard.callout).toBe('60.00')
    expect(() => acceptRate(ws, 'r999')).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('labour learned shows on labour lines', () => {
    const ws = fresh()
    const [offer] = offerRates(ws, 'labour is 95 an hour now', Date.parse('2026-11-03T15:00:00Z'))
    acceptRate(ws, offer.id)
    const line = priceLines([{ kind: 'labour', hours: 2 }], ws.settings.rateCard).lines[0]
    expect([line.amount, line.source]).toEqual(['190.00', 'you said 95 on 3 Nov'])
  })
})

describe('the agent turn carries the offer', () => {
  it('an invoice turn that says a new call out comes back with the offer on it', async () => {
    const ws = fresh()
    const out = await runTurn(ws, SAID, { callModel: fakeModel([step1, step2]), now: NOW })
    expect(out.proposal.kind).toBe('invoice')
    expect(out.proposal.rateChanges).toEqual([expect.objectContaining({ field: 'callout', value: '60.00', from: '45.00', draftId: out.proposal.draftId })])
  })

  it('a turn the model could not make still offers the rate on its own card', async () => {
    const ws = fresh()
    const out = await runTurn(ws, 'call out is 60 now', { callModel: fakeModel(['nope', 'nope']), now: NOW })
    expect(out.message).toBeNull()
    expect(out.proposal).toMatchObject({ kind: 'rate', rateChanges: [expect.objectContaining({ field: 'callout', value: '60.00' })] })
  })

  it('a turn with no new rate has no offer', async () => {
    const ws = fresh()
    const out = await runTurn(ws, SAID.replace(', call out is 60 now', ''), { callModel: fakeModel([step1, step2]), now: NOW })
    expect(out.proposal.rateChanges).toBeUndefined()
  })
})
