import { describe, it, expect } from 'vitest'
import { checkFinal, scrubText } from '../../src/agent/guard.js'

const transcript = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.'

describe('waiting proposal guard', () => {
  const context = { results: [{ tool: 'find_customer', result: { matches: [{ id: 'c2' }] } }], transcript: 'Put Dave on the waiting list for a two hour shower job, mornings' }
  const final = { kind: 'waiting', customer_id: 'c2', summary: 'Shower job', hours: 2, free: 'mornings' }
  it('drops a waiting customer the lookup did not return', () => {
    expect(checkFinal({ ...final, customer_id: 'c3' }, context)).toEqual({ ok: false, reason: 'not backed by a tool result' })
  })
  it('drops waiting hours not said in the words', () => {
    expect(checkFinal({ ...final, hours: 3 }, context)).toEqual({ ok: false, reason: 'the waiting hours were not said' })
  })
  it('passes a waiting proposal backed by the customer lookup and spoken duration', () => {
    expect(checkFinal(final, context)).toEqual({ ok: true, proposal: final })
  })
  it('defaults waiting availability and rejects invalid fields', () => {
    const { free, ...plain } = final
    expect(checkFinal(plain, context)).toEqual({ ok: true, proposal: { ...plain, free: 'any' } })
    for (const bad of [{ summary: '' }, { summary: 'a'.repeat(81) }, { hours: 1.25 }, { free: 'evenings' }, { free: [0] }]) {
      expect(checkFinal({ ...final, ...bad }, context).ok).toBe(false)
    }
  })
})

/** Tool results of a normal Maria turn. */
function results() {
  return [
    { tool: 'find_customer', result: { matches: [{ id: 'c1', name: 'Maria Lopez', address: '14 Elm Street' }] } },
    {
      tool: 'price_lines',
      result: {
        lines: [
          { id: 'p1', kind: 'callout', name: 'Call out', quantity: '1', unitAmount: '45.00', amount: '45.00' },
          { id: 'p2', kind: 'labour', name: 'Labour', quantity: '1.5', unitAmount: '85.00', amount: '127.50' },
          { id: 'p3', kind: 'part', name: 'Kitchen tap', quantity: '1', unitAmount: '89.00', amount: '89.00', cost: 89 },
        ],
        refused: [],
        itemTotal: '261.50', tax: '20.92', total: '282.42',
      },
    },
  ]
}

describe('the drop rule', () => {
  it('passes a proposal whose every id came from a tool result', () => {
    const r = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2', 'p3'] }, { results: results(), transcript })
    expect(r.ok).toBe(true)
  })

  it('drops a proposal with a line id no tool returned', () => {
    const r = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p9'] }, { results: results(), transcript })
    expect(r).toMatchObject({ ok: false, reason: 'not backed by a tool result' })
  })

  it('drops a proposal with a customer id no tool returned', () => {
    const r = checkFinal({ kind: 'invoice', customer_id: 'c3', line_ids: ['p1'] }, { results: results(), transcript })
    expect(r.ok).toBe(false)
  })

  it('removes a sentence holding an amount not in the tool results', () => {
    const text = 'Thanks Maria. The total is 282.42. I knocked it down to 250.00 for you.'
    const out = scrubText(text, { results: results(), transcript })
    expect(out.text).toBe('Thanks Maria. The total is 282.42.')
    expect(out.removed).toEqual(['I knocked it down to 250.00 for you.'])
  })

  it('refuses a part cost that is not in the transcript', () => {
    const bad = results()
    bad[1].result.lines[2] = { id: 'p3', kind: 'part', name: 'Kitchen tap', quantity: '1', unitAmount: '98.00', amount: '98.00', cost: 98 }
    const r = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2', 'p3'] }, { results: bad, transcript })
    expect(r).toMatchObject({ ok: false })
    expect(r.reason).toMatch(/part cost/)
  })

  it('refuses labour hours that do not match what was said', () => {
    const bad = results()
    bad[1].result.lines[1] = { id: 'p2', kind: 'labour', name: 'Labour', quantity: '2', unitAmount: '85.00', amount: '170.00' }
    const r = checkFinal({ kind: 'invoice', customer_id: 'c1', line_ids: ['p1', 'p2'] }, { results: bad, transcript })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/hours/)
  })

  it('an unknown customer cannot be invoiced; it becomes a new customer to confirm', () => {
    const none = [{ tool: 'find_customer', result: { matches: [] } }, results()[1]]
    const r = checkFinal({ kind: 'invoice', customer_id: 'new', customer_name: 'Bob', line_ids: ['p1'] }, { results: none, transcript: 'Tap for Bob, an hour' })
    expect(r).toMatchObject({ ok: true, proposal: { kind: 'new_customer', name: 'Bob' } })
  })

  it('cash must not be more than the due amount and must have been said', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-DAVE', customer_id: 'c2', due: '120.00', total: '120.00' }] } }]
    expect(checkFinal({ kind: 'cash', invoice_id: 'INV2-DAVE', amount: '120.00' }, { results: open, transcript: 'Dave paid cash, 120' }).ok).toBe(true)
    expect(checkFinal({ kind: 'cash', invoice_id: 'INV2-DAVE', amount: '150.00' }, { results: open, transcript: 'Dave paid cash, 150' })).toMatchObject({ ok: false })
    expect(checkFinal({ kind: 'cash', invoice_id: 'INV2-DAVE', amount: '120.00' }, { results: open, transcript: 'Dave paid cash' })).toMatchObject({ ok: false })
  })

  it('a booking needs a slot a tool returned', () => {
    const slots = [{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }, { tool: 'find_slots', result: { slots: [{ id: 's1', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:30:00.000Z', label: 'Tue 3 Nov 9:00' }] } }]
    expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's1', summary: 'Bathroom tap' }, { results: slots, transcript }).ok).toBe(true)
    expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's7', summary: 'Bathroom tap' }, { results: slots, transcript }).ok).toBe(false)
  })

  it('an answer keeps only sentences whose figures and invoice ids are backed', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-SAM', customer: 'Sam Okafor', due: '340.00', days_since_sent: 15 }], total_due: '340.00' } }]
    const r = checkFinal({ kind: 'answer', text: '340 from Sam, 15 days late. Plus 99 from someone.', invoice_ids: ['INV2-SAM', 'INV2-FAKE'] }, { results: open, transcript: 'What am I owed?' })
    expect(r.ok).toBe(true)
    expect(r.proposal.text).toBe('340 from Sam, 15 days late.')
    expect(r.proposal.invoice_ids).toEqual(['INV2-SAM'])
  })

  it('drops a grand total answer that leaves out an open invoice due', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-SAM', customer: 'Sam Okafor', due: '340.00' },
      { invoice_id: 'INV-MARIA', customer: 'Maria Lopez', due: '282.42' },
      { invoice_id: 'INV-DEPOSIT', customer: 'Maria Lopez', due: '50.00' },
    ], total_due: '672.42' } }]
    const r = checkFinal({ kind: 'answer', text: 'You are owed 340.00 by Sam Okafor and 282.42 by Maria Lopez. Total owed is 672.42.', invoice_ids: [] }, { results: open, transcript: 'What am I owed?' })
    expect(r.proposal.text).toBe('')
  })

  it('keeps a grand total answer when it lists every open invoice due', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-SAM', customer: 'Sam Okafor', due: '340.00' },
      { invoice_id: 'INV-MARIA', customer: 'Maria Lopez', due: '282.42' },
      { invoice_id: 'INV-DEPOSIT', customer: 'Maria Lopez', due: '50.00' },
    ], total_due: '672.42' } }]
    const text = 'You are owed 340.00 by Sam Okafor, 282.42 by Maria Lopez and a deposit of 50.00. Total owed is 672.42.'
    const r = checkFinal({ kind: 'answer', text, invoice_ids: [] }, { results: open, transcript: 'What am I owed?' })
    expect(r.proposal.text).toBe(text)
  })

  it('counts repeated due amounts when a grand total is named', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-A', customer: 'A', due: '50.00' },
      { invoice_id: 'INV-B', customer: 'B', due: '50.00' },
    ], total_due: '100.00' } }]
    const once = checkFinal({ kind: 'answer', text: '50.00 from A. 100.00 in all.', invoice_ids: [] }, { results: open, transcript: '' })
    const twiceText = '50.00 from A and 50.00 from B. 100.00 in all.'
    const twice = checkFinal({ kind: 'answer', text: twiceText, invoice_ids: [] }, { results: open, transcript: '' })
    expect(once.proposal.text).toBe('')
    expect(twice.proposal.text).toBe(twiceText)
  })

  it('compares differently formatted amounts in cents, including comma grouped amounts', () => {
    const repeated = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-A', customer: 'A', due: '50.00' },
      { invoice_id: 'INV-B', customer: 'B', due: '50.00' },
    ], total_due: '100.00' } }]
    const repeatedText = '50 from A. 50.0 from B. 100.00 in all.'
    expect(checkFinal({ kind: 'answer', text: repeatedText, invoice_ids: [] }, { results: repeated, transcript: '' }).proposal.text).toBe(repeatedText)

    const grouped = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-C', customer: 'C', due: '1234.50' },
      { invoice_id: 'INV-D', customer: 'D', due: '1.00' },
    ], total_due: '1235.50' } }]
    const groupedText = '1,234.50 from C and 1.00 from D. 1,235.50 in all.'
    expect(checkFinal({ kind: 'answer', text: groupedText, invoice_ids: [] }, { results: grouped, transcript: '' }).proposal.text).toBe(groupedText)
  })

  it('does not require every due when the answer omits the grand total or has one open invoice', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [
      { invoice_id: 'INV-A', customer: 'A', due: '50.00' },
      { invoice_id: 'INV-B', customer: 'B', due: '50.00' },
    ], total_due: '100.00' } }]
    const answer = 'Maria owes 50.00 and a deposit of 50.00'
    expect(checkFinal({ kind: 'answer', text: answer, invoice_ids: [] }, { results: open, transcript: '' }).proposal.text).toBe(answer)
    const single = [{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV-A', customer: 'A', due: '50.00' }], total_due: '50.00' } }]
    const singleText = '50.00 in all.'
    expect(checkFinal({ kind: 'answer', text: singleText, invoice_ids: [] }, { results: single, transcript: '' }).proposal.text).toBe(singleText)
  })

  it('an unknown proposal kind is dropped', () => {
    expect(checkFinal({ kind: 'refund', invoice_id: 'x' }, { results: [], transcript: '' }).ok).toBe(false)
  })
})

describe('currency signs', () => {
  it('are taken out of model text; the figures stay when backed', () => {
    const open = [{ tool: 'open_invoices', result: { invoices: [{ invoice_id: 'INV2-SAM', due: '340.00' }], total_due: '340.00' } }]
    expect(scrubText('You are owed £340.00 by Sam.', { results: open, transcript: '' }).text).toBe('You are owed 340.00 by Sam.')
    expect(scrubText('That is $ 340.00 in all.', { results: open, transcript: '' }).text).toBe('That is 340.00 in all.')
  })
})

describe('claims are enforced', () => {
  const empty = { results: [], transcript: '' }
  const slots = [{ id: 's1', start: '2026-11-02T08:00:00.000Z', end: '2026-11-02T09:00:00.000Z' }, { id: 's2', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' }]
  const bookingCtx = { results: [{ tool: 'find_customer', result: { matches: [{ id: 'c1' }] } }, { tool: 'find_slots', result: { slots } }], transcript: 'Book the bathroom tap for Maria next week.' }

  it('drops a booking that is not the first free slot', () => {
    expect(checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's2', summary: 'Bathroom tap' }, bookingCtx)).toEqual({ ok: false, reason: 'not the first free slot' })
  })

  it('removes an unsupported figure from a booking summary', () => {
    const out = checkFinal({ kind: 'booking', customer_id: 'c1', slot_id: 's1', summary: 'Bathroom tap costs 999.00.' }, bookingCtx)
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain('999')
    expect(out.proposal.summary).toBe('Job')
  })

  it('treats small amounts with a currency as money', () => {
    for (const text of ['You owe 5 dollars.', 'You owe $5.', 'You owe five dollars.']) expect(scrubText(text, empty).text).toBe('')
    expect(scrubText('You owe 5 dollars.', { results: [], transcript: 'she paid 5 dollars' }).text).toBe('You owe 5 dollars.')
    for (const text of ['Come at 9.', 'It took 2 hours.', 'You have 3 invoices.']) expect(scrubText(text, empty).text).toBe(text)
  })

  const invoices = [
    { invoice_id: 'A', customer_id: 'c1', due: 50, total: 50, days_since_sent: 14 },
    { invoice_id: 'B', customer_id: 'c3', due: 999, total: 999, days_since_sent: 2 },
  ]
  const owedCtx = { results: [{ tool: 'open_invoices', result: { invoices } }], transcript: 'What am I owed? I said 70 earlier.' }

  it('links an owed amount to the invoice it came from', () => {
    const out = checkFinal({ kind: 'answer', text: '999.00 is owed.', invoice_ids: ['A'] }, owedCtx)
    expect(out.ok && out.proposal.text).toBe('999.00 is owed.')
    expect(out.ok && out.proposal.invoice_ids).toContain('B')
  })

  it('removes an amount that is no invoice amount', () => {
    const out = checkFinal({ kind: 'answer', text: '70.00 is owed.', invoice_ids: [] }, owedCtx)
    expect(out.ok && out.proposal.text).toBe('')
  })

  it('keeps counts and days in an answer', () => {
    const out = checkFinal({ kind: 'answer', text: 'Sam is 14 days late.', invoice_ids: ['A'] }, owedCtx)
    expect(out.ok && out.proposal.text).toBe('Sam is 14 days late.')
  })

  it('removes unsupported figures from a new customer name', () => {
    const out = checkFinal({ kind: 'invoice', customer_id: 'new', customer_name: 'Bob 999.00' }, { results: [{ tool: 'find_customer', result: { matches: [] } }], transcript: 'Tap for Bob, an hour.' })
    expect(out.ok && out.proposal.kind).toBe('new_customer')
    expect(JSON.stringify(out)).not.toContain('999')
  })
})

describe('currency signs', () => {
  it('strips every currency sign and leaves letters alone', () => {
    const ctx = { results: [], transcript: '5.50' }
    expect(scrubText('It is £5.50. Or €5.50. Or ₹5.50. Or $5.50.', ctx).text).toBe('It is 5.50. Or 5.50. Or 5.50. Or 5.50.')
    expect(scrubText('Café crème is fine.', ctx).text).toBe('Café crème is fine.')
    expect(scrubText('Ça va, â bientôt.', ctx).text).toBe('Ça va, â bientôt.')
  })
})
