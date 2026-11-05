// @ts-check

/** @type {Readonly<{currency: string, callout: string, labourPerHour: string, billingStepMinutes: number, taxPercent: string, deposit: string}>} */
export const DEMO_RATE_CARD = Object.freeze({
  // Demo settings for sample pricing.
  currency: 'USD',
  callout: '45.00',
  labourPerHour: '85.00',
  billingStepMinutes: 15,
  taxPercent: '8',
  deposit: '50.00',
})

/** @param {string | number} value */
export function toCents(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER / 100) return NaN
  return Math.round(amount * 100 + Number.EPSILON * Math.sign(amount) * Math.abs(amount * 100))
}

/** @param {number} cents */
export function fromCents(cents) {
  return (cents / 100).toFixed(2)
}

/** @typedef {{kind: 'callout'} | {kind: 'labour', hours: number, description?: string} | {kind: 'part', description: string, cost: string | number}} PriceLineInput */
/** @typedef {{currency: string, callout: string, labourPerHour: string, billingStepMinutes: number, taxPercent: string, deposit: string, learned?: Record<string, {said: string, on: string}>}} RateCard */

/** @param {PriceLineInput[]} inputs @param {RateCard} card */
export function priceLines(inputs, card) {
  const taxRate = Number(card.taxPercent) / 100
  const lines = inputs.map((line, index) => {
    let kind = line.kind
    let name
    let quantity
    let unitCents
    let uom
    let source = 'rate card'
    if (line.kind === 'callout') {
      name = 'Call out'; quantity = 1; unitCents = toCents(card.callout); uom = 'AMOUNT'
      source = learnedSource(card, 'callout')
    } else if (line.kind === 'labour') {
      if (!Number.isFinite(line.hours) || line.hours <= 0) throw new Error('Labour hours must be greater than zero')
      name = 'Labour'; quantity = line.hours; unitCents = toCents(card.labourPerHour); uom = 'HOURS'
      source = learnedSource(card, 'labourPerHour')
    } else if (line.kind === 'part') {
      const cost = Number(line.cost)
      if ((typeof line.cost === 'string' && !line.cost.trim()) || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(toCents(cost))) throw new Error('Part cost must be a non negative number')
      name = line.description; quantity = 1; unitCents = toCents(cost); uom = 'QUANTITY'
      const typed = String(line.cost).replace(/\.0+$/, '')
      source = `you said ${typed}`
    } else {
      throw new Error(`Unknown line kind: ${/** @type {any} */ (line).kind}`)
    }
    const quantityText = String(quantity)
    const amountCents = Math.round(quantity * unitCents)
    if (!Number.isSafeInteger(amountCents)) throw new Error('Line amount is too large')
    return { id: `p${index + 1}`, kind, name, description: line.kind === 'labour' ? line.description : undefined, quantity: quantityText, unitAmount: fromCents(unitCents), uom, amount: fromCents(amountCents), tax: fromCents(Math.round(amountCents * taxRate)), source }
  })
  const itemCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0)
  const taxCents = lines.reduce((sum, line) => sum + toCents(line.tax), 0)
  return { lines, itemTotal: fromCents(itemCents), tax: fromCents(taxCents), total: fromCents(itemCents + taxCents), taxPercent: card.taxPercent, currency: card.currency }
}

/** A rate the tradesperson said and tapped in names where it came from. @param {RateCard} card @param {string} field */
function learnedSource(card, field) {
  const l = card.learned?.[field]
  return l ? `you said ${l.said} on ${l.on}` : 'rate card'
}

/** @param {RateCard} card */
export function depositPriced(card) {
  const amount = card.deposit
  return {
    lines: [{ id: 'p1', kind: 'deposit', name: 'Deposit', quantity: '1', unitAmount: amount, uom: 'AMOUNT', amount, tax: '0.00', source: 'rate card' }],
    itemTotal: amount,
    tax: '0.00',
    total: amount,
    taxPercent: '0',
    currency: card.currency,
  }
}
