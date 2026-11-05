// @ts-check
// The rate card that learns. Code reads a new call out or labour rate from the words said ("call out is 60 now"),
// never from the model, and offers it as a one tap change. The tap changes the card, prices the open draft again,
// and the card then names the source of that rate on every line ("you said 60 on 28 Oct").

import { nextId } from '../state/workspace.js'
import { balancePrice } from './send.js'
import { priceLines } from '../pricing/ratecard.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FIELDS = /** @type {const} */ (['callout', 'labourPerHour'])
const LABELS = { callout: 'Call out', labourPerHour: 'Labour per hour' }
const MAX_OFFERS = 10

const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety'
const UNITS = 'one|two|three|four|five|six|seven|eight|nine'
const TEN_VALUE = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const UNIT_VALUE = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
// A money amount said as digits or as words, for example "60", "92.50", "sixty five", "a hundred and ten".
const AMOUNT = String.raw`(\d{1,4}(?:\.\d{1,2})?|(?:a|one|two) hundred(?: (?:and )?(?:${TENS})(?: (?:${UNITS}))?)?|(?:${TENS})(?: (?:${UNITS}))?)`
// Words that may sit between the rate's name and its amount: "call out is now 60", "labour goes up to 95".
const FILLER = '(?: (?:is|s|was|are|now|at|of|to|goes|going|went|up|will|be|gone|has|have|just|my|the|its|it|i|set|put|change|changed|raise|raised|should|from|today|on|fee|charge|rate|price|cost|costs))*'
// After the amount: a time or a length of time is not a rate.
const NOT_TIME = String.raw`(?![\d:])(?! (?:am|pm|a m|p m|o clock|oclock|hours?|hrs?|minutes?|mins?)\b)`
const FORMS = [
  { field: 'callout', re: new RegExp(String.raw`\bcall ?outs?\b${FILLER} ${AMOUNT}${NOT_TIME}`, 'g') },
  { field: 'labourPerHour', re: new RegExp(String.raw`\b(?:labour|labor|hourly)(?: rate)?\b${FILLER} ${AMOUNT}${NOT_TIME}`, 'g') },
  { field: 'labourPerHour', re: new RegExp(String.raw`\b${AMOUNT} (?:an|a|per) hour\b`, 'g') },
]

/** @param {string} said */
function amountOf(said) {
  if (/^\d/.test(said)) return Number(said)
  let total = 0
  for (const word of said.split(' ')) {
    if (word === 'hundred') total = (total || 1) * 100
    else if (word in TEN_VALUE) total += TEN_VALUE[/** @type {keyof typeof TEN_VALUE} */ (word)]
    else if (word in UNIT_VALUE) total += UNIT_VALUE[/** @type {keyof typeof UNIT_VALUE} */ (word)]
  }
  return total
}

/**
 * Each call out or labour rate said in the text, the last one said for each; amounts outside 10 to 1000 are left out.
 * @param {string} text
 * @returns {Array<{ field: 'callout' | 'labourPerHour', value: string, said: string }>}
 */
export function ratesSaid(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[-‐‑–—]/g, ' ').replace(/['’$]/g, '').replace(/[,;!?]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ')} `
  /** @type {Map<string, { at: number, value: string, said: string }>} */
  const last = new Map()
  for (const form of FORMS) {
    for (const m of s.matchAll(form.re)) {
      const amount = amountOf(m[1])
      if (!(amount >= 10 && amount <= 1000)) continue
      const at = /** @type {number} */ (m.index)
      const prev = last.get(form.field)
      if (prev && prev.at > at) continue
      last.set(form.field, { at, value: amount.toFixed(2), said: /^\d/.test(m[1]) ? m[1] : String(amount) })
    }
  }
  return FIELDS.filter((f) => last.has(f)).map((field) => {
    const { value, said } = /** @type {{ value: string, said: string }} */ (last.get(field))
    return { field, value, said }
  })
}

/** The day in the workspace's local time, as "28 Oct". @param {any} ws @param {number} now */
function dayText(ws, now) {
  const local = new Date(now + (ws.tz || 0) * 60_000)
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`
}

/**
 * One tap offers for each rate said that differs from the card. They are kept in the workspace, so the tap changes
 * the card only to a rate that code read from the words.
 * @param {any} ws @param {string} transcript @param {number} now @param {string} [draftId]
 */
export function offerRates(ws, transcript, now, draftId) {
  const card = ws.settings.rateCard
  ws.rateOffers ??= {}
  const out = []
  for (const r of ratesSaid(transcript)) {
    if (Math.round(Number(card[r.field]) * 100) === Math.round(Number(r.value) * 100)) continue
    const offer = { id: nextId(ws, 'r'), field: r.field, label: LABELS[r.field], from: card[r.field], value: r.value, said: r.said, on: dayText(ws, now), at: now, draftId }
    ws.rateOffers[offer.id] = offer
    out.push(offer)
  }
  const ids = Object.keys(ws.rateOffers)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_OFFERS))) delete ws.rateOffers[id]
  return out
}

/**
 * The tap: the card takes the rate, and the draft it was said with is priced again when it is not sent yet.
 * A second tap changes nothing more.
 * @param {any} ws @param {string} offerId
 * @returns {{ draftId?: string, priced?: any }}
 */
export function acceptRate(ws, offerId) {
  const offer = ws.rateOffers?.[offerId]
  if (!offer) throw Object.assign(new Error('That rate change is gone. Say it again.'), { code: 'NOT_FOUND', status: 404 })
  if (offer.accepted) return {}
  const card = ws.settings.rateCard
  card[offer.field] = offer.value
  card.learned = { ...card.learned, [offer.field]: { said: offer.said, on: offer.on } }
  offer.accepted = true
  const draft = offer.draftId ? ws.drafts[offer.draftId] : undefined
  if (!draft || draft.invoiceId || draft.settlementId || draft.kind !== 'invoice') return {}
  const old = draft.priced.lines
  const inputs = old.map((l) => (l.kind === 'callout' ? { kind: 'callout' } : l.kind === 'labour' ? { kind: 'labour', hours: Number(l.quantity), description: l.description } : { kind: 'part', description: l.name, cost: l.unitAmount }))
  const priced = priceLines(inputs, card)
  // A part keeps the words it was said with ("you said 89"), not its stored two place amount.
  priced.lines = priced.lines.map((l, i) => (l.kind === 'part' ? { ...l, source: old[i].source } : l))
  draft.priced = balancePrice(ws, draft.jobId, priced)
  return { draftId: draft.id, priced: draft.priced }
}
