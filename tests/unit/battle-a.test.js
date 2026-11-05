import { describe, it, expect } from 'vitest'
import { DEMO_RATE_CARD, priceLines, toCents } from '../../src/pricing/ratecard.js'
import { costWasSaid, durationHours, numbersIn } from '../../src/pricing/words.js'
import { checkFinal, scrubText } from '../../src/agent/guard.js'
import { applyStatus } from '../../src/state/money.js'
import { recordCashTap } from '../../src/flows/cash.js'
import { seedWorkspace } from '../../src/state/workspace.js'

describe('spoken input attacks', () => {
  it.each([
    ['forty five quid of parts', [45]],
    ['parts were 12.50 and 3.20', [12.5, 3.2]],
    ['$0.005', [0.005]],
    ['1,200', [1200]],
    ['12,50', []],
    ['minus 20', [20]],
    ['Flat 3B', []],
    ['words with no number', []],
  ])('extracts figures from %s', (text, values) => {
    expect(numbersIn(text)).toEqual(values)
  })

  it('does not treat an ambiguous comma as either a decimal or a thousands separator', () => {
    expect(costWasSaid('The part cost 12,50', 12.5)).toBe(false)
    expect(costWasSaid('The part cost 12,50', 1250)).toBe(false)
    expect(costWasSaid('The part cost 12,50', 12)).toBe(false)
    expect(costWasSaid('The part cost 12,50', 50)).toBe(false)
    expect(costWasSaid('The part cost minus 20', 20)).toBe(false)
  })

  it('handles clear duration variants without pulling a number from a name', () => {
    expect(durationHours('Flat 3B took an hour and a bit', 15)).toBe(null)
    expect(durationHours('Flat 3B was done', 15)).toBe(null)
    expect(durationHours('1.5h on the job', 15)).toBe(1.5)
    expect(durationHours('a couple of hours', 15)).toBe(null)
    expect(durationHours('two and a half hours', 15)).toBe(2.5)
    expect(durationHours('90 mins', 15)).toBe(1.5)
    expect(durationHours('half an hour', 15)).toBe(0.5)
  })
})

describe('money arithmetic attacks', () => {
  it.each([
    [0.1 + 0.2, 30],
    [' 12.50 ', 1250],
    ['12,50', NaN],
    [0, 0],
    [-20, -2000],
    [NaN, NaN],
    [Infinity, NaN],
    [1e100, NaN],
  ])('converts %s to cents', (amount, cents) => {
    expect(toCents(amount)).toBe(cents)
  })

  it('keeps extensions and odd cent tax consistent', () => {
    const product = priceLines([
      { kind: 'part', description: 'Three fittings', cost: 33.33 },
      { kind: 'part', description: 'Odd cents', cost: 0.31 },
    ], DEMO_RATE_CARD)
    expect(product.itemTotal).toBe('33.64')
    expect(product.tax).toBe('2.69')
    expect(product.total).toBe('36.33')
  })

  it.each([-0.01, NaN, Infinity, '   ', 'not money', 1e100])('rejects invalid part price %s', (cost) => {
    expect(() => priceLines([{ kind: 'part', description: 'Pipe', cost }], DEMO_RATE_CARD)).toThrow()
  })

  it('allows a zero cost part', () => {
    expect(priceLines([{ kind: 'part', description: 'Warranty part', cost: 0 }], DEMO_RATE_CARD).itemTotal).toBe('0.00')
  })
})

describe('guard attacks', () => {
  const ctx = {
    transcript: 'Sam paid 20 cash for Flat 3B',
    results: [
      { tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV1', due: '20.00' }] } },
      { tool: 'price_lines', result: { lines: [{ id: 'p1', kind: 'part', cost: 20, unitAmount: '20.00' }] } },
      { tool: 'find_slots', result: { slots: [{ id: 's1' }] } },
    ],
  }

  it('drops a final summary that invents a figure', () => {
    const checked = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1'], summary: 'Total 999.00' }, {
      ...ctx,
      results: [...ctx.results, { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }],
    })
    expect(checked.ok && checked.proposal.summary).not.toContain('999')
  })

  it('removes currency markers embedded in a word', () => {
    expect(scrubText('Total is USD$20.00.', ctx).text).toBe('Total is USD20.00.')
  })

  it('removes invented due dates even when their day is a small count', () => {
    expect(scrubText('Please pay by 12 November 2027.', ctx).text).toBe('')
  })

  it('filters unknown invoice ids from answer citations', () => {
    const checked = checkFinal({ kind: 'answer', text: 'Sam paid 20.', invoice_ids: ['INV1', 'INV404'] }, ctx)
    expect(checked.ok && checked.proposal.invoice_ids).toEqual(['INV1'])
  })

  it('does not allow a priced line id to be used twice', () => {
    const checked = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p1'] }, {
      ...ctx,
      results: [...ctx.results, { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }],
    })
    expect(checked.ok).toBe(false)
  })

  it('accepts only a slot id that a slot tool returned', () => {
    const checked = checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's2' }, {
      ...ctx,
      results: [...ctx.results, { tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }],
    })
    expect(checked.ok).toBe(false)
  })
})

describe('invoice status attacks', () => {
  function workspace() {
    const ws = seedWorkspace({ id: 'battle', now: 1_800_000_000_000, tzOffsetMinutes: 0 })
    ws.invoices.I1 = { id: 'I1', customerId: 'c2', jobId: 'j1', kind: 'invoice', total: '100.00', due: '100.00', status: 'SENT' }
    return ws
  }

  it('records a partial payment then a paid webhook and ignores a late unpaid event', () => {
    const ws = workspace()
    expect(applyStatus(ws, 'I1', 'PARTIALLY_PAID', 10, { due: '60.00', paid: '40.00' })).toBe(true)
    expect(ws.invoices.I1.due).toBe('60.00')
    expect(applyStatus(ws, 'I1', 'PAID', 20)).toBe(true)
    expect(ws.invoices.I1.due).toBe('0.00')
    expect(applyStatus(ws, 'I1', 'UNPAID', 30, { due: '100.00' })).toBe(false)
    expect(ws.invoices.I1.status).toBe('PAID')
    expect(ws.invoices.I1.due).toBe('0.00')
  })

  it.each(['CANCELLED', 'REFUNDED'])('does not make terminal invoice %s payable', (status) => {
    const ws = workspace()
    ws.invoices.I1.status = status
    applyStatus(ws, 'I1', 'PAID', 20)
    expect(ws.jobs.find((job) => job.id === 'j1').state).not.toBe('paid')
  })

  it('does not emit a second paid notice for duplicate paid events', () => {
    const ws = workspace()
    expect(applyStatus(ws, 'I1', 'PAID', 10)).toBe(true)
    const count = ws.notices.length
    expect(applyStatus(ws, 'I1', 'MARKED_AS_PAID', 20)).toBe(false)
    expect(ws.notices.length).toBe(count)
  })

  it('does not record the same cash payment twice after the due reaches zero', async () => {
    const ws = workspace()
    let paid = false
    const posts = []
    const api = {
      request: async ({ method }) => {
        if (method === 'POST') {
          posts.push(true)
          paid = true
          return { ok: true, status: 200, json: {} }
        }
        return { ok: true, status: 200, json: {
          id: 'I1', status: paid ? 'MARKED_AS_PAID' : 'SENT',
          amount: { value: '100.00', currency_code: 'USD' },
          due_amount: { value: paid ? '0.00' : '100.00' },
        } }
      },
    }
    await recordCashTap(ws, 'I1', '100.00', { api, now: 1_800_000_000_000 })
    await expect(recordCashTap(ws, 'I1', '100.00', { api, now: 1_800_000_000_000 })).rejects.toMatchObject({ code: 'CASH_CLOSED' })
    expect(posts).toHaveLength(1)
  })

  it.each(['MARKED_AS_PAID', 'CANCELLED', 'REFUNDED'])('refuses cash on live status %s', async (status) => {
    const ws = workspace()
    const calls = []
    const api = { request: async ({ method }) => {
      calls.push(method)
      return { ok: true, status: 200, json: {
        id: 'I1', status, amount: { value: '100.00', currency_code: 'USD' }, due_amount: { value: '100.00' },
      } }
    } }
    await expect(recordCashTap(ws, 'I1', '20.00', { api, now: 1_800_000_000_000 })).rejects.toMatchObject({ code: 'CASH_CLOSED' })
    expect(calls).toEqual(['GET'])
  })
})

describe('a dash inside an address or a time is not a minus sign', () => {
  it('keeps a spoken part cost when the line also holds 14-16 Elm Street or 9-5', () => {
    expect(costWasSaid('Job at 14-16 Elm Street, the tap was 89', 89)).toBe(true)
    expect(costWasSaid('open 9-5, washer cost 30', 30)).toBe(true)
    expect(costWasSaid('open 9-5, washer 30', 30)).toBe(false)
  })

  it('still refuses a cost that was said as negative', () => {
    expect(costWasSaid('parts minus 20', 20)).toBe(false)
    expect(costWasSaid('parts -20', 20)).toBe(false)
    expect(costWasSaid('parts were -20 and the tap cost 89', 89)).toBe(true)
  })
})
