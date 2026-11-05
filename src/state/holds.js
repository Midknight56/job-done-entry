// @ts-check
// Holds: the calendar that acts on money. A booked slot waits for its deposit; when the hold runs out unpaid the
// deposit invoice is cancelled, the slot is freed and the first waiting job that fits is moved in, with its own
// deposit drafted for one tap. The agent moves the calendar by itself; money requests always wait for a tap.
import { proposeInvoiceDraft, sendDraft } from '../flows/send.js'
import { cancelInvoice, getInvoice } from '../paypal/invoices.js'
import { depositPriced } from '../pricing/ratecard.js'
import { customer, job, nextId, pushNotice } from './workspace.js'
import { clashes, slotLabel } from './schedule.js'
import { applyStatus } from './money.js'
import { freeFor, availabilityReason } from './waiting.js'

const DRAFT_MINUTES_MIN = 30
const HOLD_TRIES_MAX = 10
const HOLD_RETRY_MS = 60_000

/** @param {any} ws @param {{ customerId: string, summary: string, hours: number, slot: any, now: number }} p */
export function placeBooking(ws, { customerId, summary, hours, slot, now }) {
  let id = nextId(ws, 'j')
  while (job(ws, id)) id = nextId(ws, 'j')
  const j = { id, customerId, summary, start: slot.start, end: slot.end, state: 'draft', draftedAt: now, hours }
  ws.jobs.push(j)
  const draft = proposeInvoiceDraft(ws, { customerId, priced: depositPriced(ws.settings.rateCard), summary: `Deposit to hold ${slot.label}`, jobId: j.id, kind: 'deposit' })
  return { job: j, draft }
}

/** @param {any} ws @param {string} jobId @param {string} invoiceId @param {number} now */
export function startHold(ws, jobId, invoiceId, now) {
  const j = job(ws, jobId)
  if (!j) throw new Error('No such job')
  const hold = { jobId, invoiceId, start: j.start, end: j.end, expiresAt: now + ws.settings.holdMinutes * 60_000, tries: 0 }
  ws.holds.push(hold)
  return hold
}

/** @param {any} ws @param {string} draftId @param {{ api: any, env: any, now: number }} deps */
export async function sendDeposit(ws, draftId, { api, env, now }) {
  const draft = ws.drafts[draftId]
  if (draft?.invoiceId && (ws.holds.some((h) => h.invoiceId === draft.invoiceId) || ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(ws.invoices[draft.invoiceId]?.status))) return { invoiceId: draft.invoiceId }
  const j = draft ? job(ws, draft.jobId) : undefined
  if (j && !freeFor(ws, j, j.start, j.end)) throw Object.assign(new Error('The customer is not free then. Choose another time.'), { code: 'AVAILABILITY', status: 409 })
  if (j && clashes(ws, j.start, j.end, j.id).length) {
    throw Object.assign(new Error('That slot was taken. Ask for another time.'), { code: 'CLASH', status: 409 })
  }
  const result = await sendDraft(ws, draftId, { api, env, now })
  if (['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'].includes(ws.invoices[result.invoiceId]?.status)) return result
  if (j) { j.state = 'held'; j.depositInvoiceId = result.invoiceId }
  if (!ws.holds.some((h) => h.invoiceId === result.invoiceId && !h.ended)) startHold(ws, draft.jobId, result.invoiceId, now)
  return { invoiceId: result.invoiceId }
}

/** @param {any} ws @param {string} invoiceId @param {number} now */
export function depositPaid(ws, invoiceId, now) {
  const hold = ws.holds.find((h) => h.invoiceId === invoiceId && !h.ended)
  if (!hold) return
  hold.ended = 'paid'
  const j = job(ws, hold.jobId)
  if (j) { j.state = 'booked'; j.depositPaid = true; j.depositInvoiceId ||= invoiceId }
  if (ws.invoices[invoiceId]) { ws.invoices[invoiceId].status = 'PAID'; ws.invoices[invoiceId].due = '0.00' }
  pushNotice(ws, { at: now, text: `Deposit paid for ${slotLabel(ws, hold.start)}.` })
}

/** @param {any} ws @param {string} invoiceId @param {number} now */
export function invoiceCancelled(ws, invoiceId, now) {
  const hold = ws.holds.find((h) => h.invoiceId === invoiceId && !h.ended)
  if (hold) release(ws, hold, now)
}

/** @param {any} ws @param {{ api: any, now: number, alarm?: boolean }} p */
export async function releaseExpired(ws, { api, now, alarm = false }) {
  const actions = []
  for (const hold of ws.holds) {
    if (hold.ended || hold.checking || hold.expiresAt > now) continue
    if (alarm && ((hold.tries || 0) >= HOLD_TRIES_MAX || (hold.retryAt || 0) > now)) continue
    if (!alarm) hold.tries = 0
    hold.checking = true
    try {
      let invoice
      try {
        invoice = await getInvoice(api, hold.invoiceId)
      } catch {
        retryHold(hold, now, alarm)
        continue
      }
      if (invoice.status === 'PARTIALLY_REFUNDED') {
        if (!Number.isFinite(Number(invoice.paid)) || !Number.isFinite(Number(invoice.refunded)) || invoice.paid == null || invoice.refunded == null) { retryHold(hold, now, alarm); continue }
        applyStatus(ws, hold.invoiceId, invoice.status, now, invoice)
      } else if (invoice.status === 'REFUNDED') {
        applyStatus(ws, hold.invoiceId, invoice.status, now, invoice)
      } else if (['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(invoice.status)) {
        depositPaid(ws, hold.invoiceId, now)
        actions.push(`Deposit paid for ${slotLabel(ws, hold.start)}.`)
      } else if (invoice.status === 'CANCELLED') {
        release(ws, hold, now)
        actions.push(`Hold ran out on ${slotLabel(ws, hold.start)}. Slot freed.`)
      } else {
        try {
          await cancelInvoice(api, hold.invoiceId, 'The hold on this slot ran out, so the slot was freed.', `jd-${ws.id}-${hold.invoiceId}-cancel`)
        } catch {
          retryHold(hold, now, alarm)
          continue
        }
        release(ws, hold, now)
        actions.push(`Hold ran out on ${slotLabel(ws, hold.start)}. Slot freed.`)
      }
    } finally {
      delete hold.checking
    }
  }
  return actions
}

/** @param {any} hold @param {number} now @param {boolean} alarm */
function retryHold(hold, now, alarm) {
  hold.tries = (hold.tries || 0) + 1
  hold.retryAt = now + HOLD_RETRY_MS
  if (alarm && hold.tries === HOLD_TRIES_MAX) console.warn('Hold retries stopped until the next state poll.')
}

/** @param {any} ws @param {any} hold @param {number} now */
function release(ws, hold, now) {
  if (hold.ended) return
  hold.ended = 'released'
  const j = job(ws, hold.jobId)
  if (j) j.state = 'released'
  if (ws.invoices[hold.invoiceId]) ws.invoices[hold.invoiceId].status = 'CANCELLED'
  const label = slotLabel(ws, hold.start)
  pushNotice(ws, { at: now, text: `Hold ran out on ${label}. Slot freed.` })
  offerNext(ws, hold.start, hold.end, now)
}

/** @param {any} ws @param {string} start @param {string} end @param {number} now @param {string} [skipJobId] */
function offerNext(ws, start, end, now, skipJobId) {
  const label = slotLabel(ws, start)
  const length = (Date.parse(end) - Date.parse(start)) / 3_600_000
  if (Object.values(ws.offers).some((offer) => !offer.accepted && offer.start && offer.end && Date.parse(offer.start) < Date.parse(end) && Date.parse(offer.end) > Date.parse(start))) return
  let skipped = ''
  const index = ws.waiting.findIndex((id, i, list) => {
    const candidate = job(ws, id)
    if (id === skipJobId || list.indexOf(id) !== i || candidate?.state !== 'waiting' || !Number.isFinite(candidate.hours) || candidate.hours <= 0) return false
    const fits = candidate.hours <= length
    const available = fits && freeFor(ws, candidate, start, new Date(Date.parse(start) + candidate.hours * 3_600_000).toISOString())
    if (!available && !skipped) {
      const person = customer(ws, candidate.customerId)
      const name = person?.given || person?.name.split(' ')[0] || 'This customer'
      skipped = fits ? `${name} is not free then.` : `${name} needs ${candidate.hours} hours.`
    }
    return available
  })
  if (index < 0) {
    pushNotice(ws, { at: now, text: `No one on the waiting list fits ${label}.` })
    return
  }
  const waitingId = ws.waiting.splice(index, 1)[0]
  // The search above only matches a waiting job that exists.
  const next = /** @type {any} */ (job(ws, waitingId))
  next.start = start
  next.end = new Date(Date.parse(start) + next.hours * 3_600_000).toISOString()
  next.state = 'offered'
  const draft = proposeInvoiceDraft(ws, { customerId: next.customerId, priced: depositPriced(ws.settings.rateCard), summary: `Deposit to hold ${label}`, jobId: next.id, kind: 'deposit' })
  const id = nextId(ws, 'o')
  const name = customer(ws, next.customerId)?.name || 'the next customer'
  const person = customer(ws, next.customerId)
  const first = person?.given || person?.name.split(' ')[0] || 'This job'
  const day = label.split(' ')[0]
  const free = next.free || 'any'
  const when = free === 'mornings' || free === 'afternoons' ? `${day} ${free}` : Array.isArray(free) ? `on ${day}` : 'then'
  const reason = `${first} was first on the waiting list who fits ${next.hours} ${next.hours === 1 ? 'hour' : 'hours'} and is free ${when}.${skipped ? ` ${skipped}` : ''}`
  ws.offers[id] = { id, jobId: next.id, draftId: draft.id, start: next.start, end: next.end, at: now, reason }
  pushNotice(ws, { at: now, kind: 'offer', text: `Offered ${label} to ${name}. ${reason} The deposit waits for your tap.` })
}

/** @param {any} ws @param {string} offerId @param {{ api: any, env: any, now: number }} deps */
export async function acceptOffer(ws, offerId, deps) {
  const offer = Object.values(ws.offers).find((o) => o.id === offerId)
  if (!offer || offer.accepted || offer.accepting) return
  const next = job(ws, offer.jobId)
  if (!next) throw Object.assign(new Error('No such job'), { code: 'NOT_FOUND', status: 404 })
  if (!customer(ws, next.customerId)) throw Object.assign(new Error('No such customer'), { code: 'NOT_FOUND', status: 404 })
  if (next.state !== 'offered' && next.state !== 'waiting') return
  if (!ws.drafts[offer.draftId]) throw Object.assign(new Error('No such draft'), { code: 'NOT_FOUND', status: 404 })
  if (!freeFor(ws, next, offer.start, offer.end)) throw Object.assign(new Error('The customer is not free then. Move or decline this offer.'), { code: 'AVAILABILITY', status: 409 })
  offer.reason = availabilityReason(ws, next, offer.start)
  if (clashes(ws, offer.start, offer.end, next.id).length) return
  next.start = offer.start
  next.end = offer.end
  offer.accepting = true
  try {
    await sendDeposit(ws, offer.draftId, deps)
    offer.accepted = true
  } finally {
    delete offer.accepting
  }
}

/** @param {any} ws @param {number} now */
export function dropStaleDrafts(ws, now) {
  const stale = new Set(ws.jobs.filter((j) => j.state === 'draft' && Number.isFinite(j.draftedAt) &&
    now - j.draftedAt > Math.max(ws.settings.holdMinutes, DRAFT_MINUTES_MIN) * 60_000 &&
    !Object.values(ws.drafts).some((d) => d.jobId === j.id && d.sentAt != null)).map((j) => j.id))
  ws.jobs = ws.jobs.filter((j) => !stale.has(j.id))
  for (const [id, draft] of Object.entries(ws.drafts)) {
    if (stale.has(draft.jobId)) delete ws.drafts[id]
  }
}

/** @param {any} ws @param {string} offerId @param {number} now */
export function declineOffer(ws, offerId, now) {
  const offer = ws.offers[offerId]
  if (!offer) throw Object.assign(new Error('That offer is gone.'), { code: 'NOT_FOUND', status: 404 })
  if (offer.accepted || offer.accepting) throw Object.assign(new Error('That offer is already accepted.'), { code: 'OFFER_CLOSED', status: 409 })
  const j = job(ws, offer.jobId)
  if (!j) throw Object.assign(new Error('No such job'), { code: 'NOT_FOUND', status: 404 })
  delete ws.offers[offerId]
  delete ws.drafts[offer.draftId]
  j.state = 'waiting'
  j.start = ''
  j.end = ''
  ws.waiting = ws.waiting.filter((id) => id !== j.id)
  ws.waiting.push(j.id)
  pushNotice(ws, { at: now, text: `${customer(ws, j.customerId)?.name || 'A customer'} passed on ${slotLabel(ws, offer.start)}.` })
  offerNext(ws, offer.start, offer.end, now, j.id)
}
