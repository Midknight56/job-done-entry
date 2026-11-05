import { describe, it, expect } from 'vitest'
import { DEMO_RATE_CARD, priceLines, toCents, fromCents } from '../../src/pricing/ratecard.js'

describe('pricing from the rate card', () => {
  it('prices the Maria job: call out, 1.5 h labour, a part at 89, tax 8 percent', () => {
    const priced = priceLines(
      [{ kind: 'callout' }, { kind: 'labour', hours: 1.5, description: 'Kitchen tap' }, { kind: 'part', description: 'Kitchen tap', cost: 89 }],
      DEMO_RATE_CARD,
    )
    expect(priced.lines.map((l) => l.id)).toEqual(['p1', 'p2', 'p3'])
    expect(priced.lines[0]).toMatchObject({ name: 'Call out', quantity: '1', unitAmount: '45.00', uom: 'AMOUNT', amount: '45.00', source: 'rate card' })
    expect(priced.lines[1]).toMatchObject({ name: 'Labour', quantity: '1.5', unitAmount: '85.00', uom: 'HOURS', amount: '127.50', source: 'rate card' })
    expect(priced.lines[2]).toMatchObject({ name: 'Kitchen tap', quantity: '1', unitAmount: '89.00', uom: 'QUANTITY', amount: '89.00', source: 'you said 89' })
    expect(priced.itemTotal).toBe('261.50')
    expect(priced.tax).toBe('20.92')
    expect(priced.total).toBe('282.42')
    expect(priced.taxPercent).toBe('8')
    expect(priced.currency).toBe('USD')
  })

  it('rounds tax per line, half up, the way PayPal did on 22 Oct (3.60 + 10.20 + 7.12)', () => {
    const priced = priceLines([{ kind: 'part', description: 'Washer', cost: 0.31 }], DEMO_RATE_CARD)
    // 0.31 x 8 percent = 0.0248, rounds to 0.02
    expect(priced.tax).toBe('0.02')
    expect(priced.total).toBe('0.33')
  })

  it('refuses a line it does not know, a negative cost and zero hours', () => {
    expect(() => priceLines([{ kind: 'discount' }], DEMO_RATE_CARD)).toThrow()
    expect(() => priceLines([{ kind: 'part', description: 'x', cost: -5 }], DEMO_RATE_CARD)).toThrow()
    expect(() => priceLines([{ kind: 'labour', hours: 0 }], DEMO_RATE_CARD)).toThrow()
  })

  it('keeps money in whole cents', () => {
    expect(toCents('127.50')).toBe(12750)
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(fromCents(28242)).toBe('282.42')
    expect(fromCents(5)).toBe('0.05')
  })
})
