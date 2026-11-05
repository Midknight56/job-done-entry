// @ts-check
// The Send tap: create the invoice, send it, get its QR code, read it back. Each draft has a fixed invoice number,
// which PayPal will not accept twice, and each step is skipped when the draft shows it done, so a repeated or
// simultaneous tap never makes a second invoice and a tap after a failure carries on where it stopped.

import { applyStatus } from '../state/money.js'
import { customer, job, nextId, pushNotice } from '../state/workspace.js'
import { createInvoice, getInvoice, invoiceBody, invoiceQr, resolveRecipient, sendInvoice } from '../paypal/invoices.js'

/**
 * @param {any} ws
 * @param {{ customerId: string, priced: any, summary: string, jobId?: string, kind?: 'invoice' | 'deposit', note?: string }} p
 */
export function proposeInvoiceDraft(ws, p) {
  const id = nextId(ws, 'd')
  const draft = { id, kind: p.kind || 'invoice', customerId: p.customerId, jobId: p.jobId, priced: p.priced, summary: p.summary, note: p.note }
  if (draft.kind === 'invoice') draft.priced = balancePrice(ws, draft.jobId, p.priced)
  ws.drafts[id] = draft
  return draft
}

/**
 * The tradesperson's choices on the draft card, set before the invoice is made. A deposit takes neither. A part
 * payment asks for at least the rate card's deposit now, so it is offered only when the total is bigger than that.
 * @param {any} draft @param {{ tip?: boolean, part?: boolean }} choice @param {{ deposit: string }} card
 */
export function setPaymentOptions(draft, choice, card) {
  if (draft.invoiceId) return
  const job = draft.kind !== 'deposit'
  draft.allowTip = job && Boolean(choice.tip)
  if (job && choice.part && cents(draft.priced.total) > cents(card.deposit)) draft.partMinimum = card.deposit
  else delete draft.partMinimum
}

/** A fixed invoice number per draft, at most 25 characters as PayPal allows. @param {string} wid @param {string} draftId */
export function invoiceNumber(wid, draftId) {
  return `JD-${wid.slice(0, 12).toUpperCase()}-${draftId.toUpperCase()}`.slice(0, 25)
}

/**
 * @param {any} ws @param {string} draftId
 * @param {{ api: any, env: any, now: number }} deps
 * @returns {Promise<{ invoiceId: string }>}
 */
export async function sendDraft(ws, draftId, { api, env, now }) {
  const draft = ws.drafts[draftId]
  if (!draft) throw Object.assign(new Error('No such draft'), { code: 'NOT_FOUND', status: 404 })
  if (draft.settlementId || job(ws, draft.jobId)?.settlementId) throw Object.assign(new Error('This job is already complete. Open its receipt.'), { code: 'ALREADY_SETTLED', status: 409 })
  if (draft.invoiceId && draft.sentAt && ws.invoices[draft.invoiceId]) return { invoiceId: draft.invoiceId }

  if (draft.requiresVisit && !draft.jobId) throw Object.assign(new Error('Confirm the visit before sending.'), { code: 'VISIT_REQUIRED', status: 409 })
  if (draft.kind === 'invoice' && draft.jobId) {
    const other = Object.values(ws.invoices).some((inv) => inv.jobId === draft.jobId && inv.kind !== 'deposit' && inv.id !== draft.invoiceId && !['CANCELLED', 'REFUNDED', 'VOIDED', 'DELETED'].includes(inv.status))
    const creating = Object.values(ws.drafts).some((d) => d.id !== draft.id && d.jobId === draft.jobId && d.kind === 'invoice' && (d.invoiceId || d.sending) && !['CANCELLED', 'REFUNDED', 'VOIDED', 'DELETED'].includes(ws.invoices[d.invoiceId]?.status))
    if (other || creating) throw Object.assign(new Error('This visit already has an invoice. Open that invoice.'), { code: 'ALREADY_INVOICED', status: 409 })
    const fresh = balancePrice(ws, draft.jobId, { ...draft.priced, total: draft.priced.jobTotal || draft.priced.total })
    if (fresh.total !== draft.priced.total || fresh.depositInvoiceId !== draft.priced.depositInvoiceId) throw Object.assign(new Error('The deposit changed. Make a new draft to check the balance.'), { code: 'BALANCE_CHANGED', status: 409 })
  }
  draft.sending = true
  try {
    const c = customer(ws, draft.customerId)
    if (!c) throw Object.assign(new Error('No such customer'), { code: 'NOT_FOUND', status: 404 })
    const email = resolveRecipient(c.email, env)
    const rid = (step) => `jd-${ws.id}-${draftId}-${step}`

    if (!draft.invoiceId) {
      if (cents(draft.priced?.total) <= 0) throw Object.assign(new Error('Nothing is left to pay.'), { code: 'NO_BALANCE', status: 409 })
      const body = invoiceBody({ business: ws.settings.business, given: c.given, surname: c.surname, email, priced: draft.priced, reference: `jd-${ws.id}-${draftId}`, note: draft.note, invoiceNumber: invoiceNumber(ws.id, draftId), allowTip: draft.allowTip, partMinimum: draft.partMinimum })
      draft.invoiceId = await createInvoice(api, body, rid('create'))
    }
    const id = draft.invoiceId
    if (!draft.sentAt) {
      const beforeSend = await getInvoice(api, id)
      if (cents(beforeSend.total) !== cents(draft.priced.total)) {
        throw Object.assign(new Error(`PayPal shows ${beforeSend.total}, the draft shows ${draft.priced.total}. Not sent.`), { code: 'TOTAL_MISMATCH', status: 409 })
      }
      await sendInvoice(api, id, rid('send'))
      draft.sentAt = now
    }
    if (!draft.qr) draft.qr = await invoiceQr(api, id, rid('qr'))
    const read = await getInvoice(api, id)

    ws.invoices[id] = {
      id,
      jobId: draft.jobId,
      customerId: draft.customerId,
      kind: draft.kind,
      total: read.total,
      due: read.due,
      status: 'DRAFT',
      sentAt: now,
      reminders: 0,
      depositCredit: draft.priced?.depositCredit,
      depositInvoiceId: draft.priced?.depositInvoiceId,
      jobTotal: draft.priced?.jobTotal,
      payerUrl: read.payerUrl,
      qr: draft.qr || undefined,
    }
    const j = draft.jobId ? job(ws, draft.jobId) : undefined
    if (j) {
      if (draft.kind === 'deposit') j.depositInvoiceId = id
      else { j.invoiceId = id; j.state = 'sent' }
    }
    applyStatus(ws, id, read.status, now, { due: read.due, paid: read.paid, tip: read.tip, refunded: read.refunded, source: 'send readback' })
    pushNotice(ws, { at: now, kind: 'sent', invoiceId: id, text: `Sent ${read.total} to ${c.name}.` })
    return { invoiceId: id }
  } finally { delete draft.sending }
}

/** Money text to whole cents, so 108.0 and 108.00 match. A missing total never matches. @param {any} v */
const cents = (v) => (v == null || v === '' ? NaN : Math.round(Number(v) * 100))

/** Credit only a settled deposit belonging to this visit. @param {any} ws @param {string} jobId @param {any} priced */
export function balancePrice(ws, jobId, priced) {
  const visit = jobId ? job(ws, jobId) : undefined
  const deposit = ws.invoices[visit?.depositInvoiceId]
  const paid = deposit && deposit.jobId === jobId && deposit.kind === 'deposit' && ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(deposit.status)
  const partial = deposit && deposit.jobId === jobId && deposit.kind === 'deposit' && deposit.status === 'PARTIALLY_REFUNDED'
  if (partial && (!Number.isFinite(cents(deposit.paid)) || !Number.isFinite(cents(deposit.refunded)) || cents(deposit.refunded) < 0 || cents(deposit.refunded) > cents(deposit.paid))) throw Object.assign(new Error('Check the deposit refund before making a balance invoice.'), { code: 'REFUND_UNRESOLVED', status: 409 })
  const retained = partial ? Math.max(0, cents(deposit.paid) - (cents(deposit.tip) || 0) - cents(deposit.refunded)) : paid ? cents(deposit.total) : 0
  const credit = Math.min(cents(priced.total), cents(deposit?.total) || 0, retained)
  if (!credit) {
    const result = { ...priced }
    delete result.depositCredit; delete result.depositInvoiceId; delete result.jobTotal
    delete result.depositTotal; delete result.depositRetained; delete result.depositSurplus
    return result
  }
  return { ...priced, jobTotal: priced.total, depositTotal: deposit.total, depositRetained: (Math.min(cents(deposit.total), retained) / 100).toFixed(2), depositSurplus: ((Math.min(cents(deposit.total), retained) - credit) / 100).toFixed(2), depositCredit: (credit / 100).toFixed(2), depositInvoiceId: deposit.id, total: ((cents(priced.total) - credit) / 100).toFixed(2) }
}

/** Complete a covered bill only after confirmation and a fresh deposit read.
 * @param {any} ws @param {string} draftId @param {{confirmed?: boolean}} choice
 * @param {{api: any, now: number}} deps */
export async function completeDraft(ws, draftId, choice, { api, now }) {
  const reject = (code, text) => { throw Object.assign(new Error(text), { code, status: 409 }) }
  const draft = ws.drafts[draftId]
  if (!draft) throw Object.assign(new Error('No such draft'), { code: 'NOT_FOUND', status: 404 })
  if (draft.settlementId && ws.settlements?.[draft.settlementId]) return { settlement: ws.settlements[draft.settlementId] }
  if (choice?.confirmed !== true) reject('CONFIRM_REQUIRED', 'Confirm the job is complete.')
  const visit = job(ws, draft.jobId)
  if (draft.kind !== 'invoice' || !visit || visit.customerId !== draft.customerId) reject('VISIT_REQUIRED', 'Confirm the visit before completing.')
  if (visit.settlementId || !['booked', 'completed'].includes(visit.state)) reject('ALREADY_SETTLED', 'This visit cannot be completed from this draft.')
  if (draft.invoiceId || Object.values(ws.invoices).some(inv => inv.jobId === visit.id && inv.kind !== 'deposit' && !['CANCELLED', 'REFUNDED', 'VOIDED', 'DELETED'].includes(inv.status)) ||
    Object.values(ws.drafts).some(d => d.id !== draft.id && d.jobId === visit.id && (d.invoiceId || d.sending))) reject('ALREADY_INVOICED', 'This visit already has an invoice. Open that invoice.')
  if (cents(draft.priced.total) !== 0 || !(cents(draft.priced.jobTotal) > 0) || !draft.priced.depositInvoiceId) reject('NO_COVER', 'The deposit must cover the whole bill.')
  const deposit = ws.invoices[draft.priced.depositInvoiceId]
  if (!deposit || deposit.jobId !== visit.id || deposit.customerId !== draft.customerId || deposit.kind !== 'deposit' || visit.depositInvoiceId !== deposit.id) reject('DEPOSIT_UNRESOLVED', 'Check the deposit before completing.')
  const live = await getInvoice(api, deposit.id)
  if (live.id !== deposit.id || !['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'PARTIALLY_REFUNDED'].includes(live.status) || cents(live.due) !== 0 ||
    !(cents(live.total) > 0) || live.currency !== ws.settings.rateCard.currency ||
    (live.paid !== undefined && (!Number.isFinite(cents(live.paid)) || cents(live.paid) - (cents(live.tip) || 0) < cents(live.total))) ||
    (live.refunded !== undefined && (!Number.isFinite(cents(live.refunded)) || cents(live.refunded) < 0)) ||
    (live.tip !== undefined && (!Number.isFinite(cents(live.tip)) || cents(live.tip) < 0)) ||
    (live.status !== 'PARTIALLY_REFUNDED' && cents(live.refunded) > 0)) reject('DEPOSIT_UNRESOLVED', 'Check the deposit payment and refund before completing.')
  const checked = structuredClone(ws)
  const verified = { ...deposit, status: live.status, total: live.total, due: live.due, paid: live.paid, refunded: live.refunded, tip: live.tip }
  checked.invoices[deposit.id] = verified
  const fresh = balancePrice(checked, visit.id, { ...draft.priced, total: draft.priced.jobTotal })
  const fields = ['total', 'jobTotal', 'depositInvoiceId', 'depositTotal', 'depositRetained', 'depositCredit', 'depositSurplus']
  if (fields.some(field => fresh[field] !== draft.priced[field])) reject('BALANCE_CHANGED', 'The deposit changed. Make a new draft to check the balance.')
  const id = nextId(ws, 's')
  const settlement = {
    id, at: now, draftId, jobId: visit.id, customerId: draft.customerId, summary: draft.summary,
    depositInvoiceId: deposit.id, depositTotal: fresh.depositTotal, depositRetained: fresh.depositRetained,
    depositCredit: fresh.depositCredit, depositSurplus: fresh.depositSurplus,
    jobTotal: fresh.jobTotal, due: '0.00', currency: ws.settings.rateCard.currency,
    resolution: cents(fresh.depositSurplus) > 0 ? 'required' : 'none',
    priced: structuredClone(fresh), deposit: verified,
  }
  ws.settlements ??= {}
  ws.settlements[id] = settlement
  draft.settlementId = id
  Object.assign(visit, { state: 'paid', completedAt: now, settlementId: id })
  pushNotice(ws, { at: now, kind: 'completed', settlementId: id, text: `Job complete. Deposit ${fresh.depositTotal}. Applied ${fresh.depositCredit}.${cents(fresh.depositSurplus) > 0 ? ` Surplus ${fresh.depositSurplus} needs resolution.` : ''}` })
  return { settlement }
}

/** Link a bill only after the person chooses a visit or its completed times.
 * @param {any} ws @param {string} draftId @param {any} fields @param {number} now */
export function confirmInvoiceVisit(ws, draftId, fields, now) {
  const draft = ws.drafts[draftId]
  const invalid = (text) => { throw Object.assign(new Error(text), { code: 'VISIT', status: 422 }) }
  if (!draft || draft.kind !== 'invoice' || draft.invoiceId || draft.settlementId) invalid('That draft cannot change visits.')
  if (draft.jobId) return job(ws, draft.jobId)
  let visit
  if (fields.jobId) {
    visit = job(ws, fields.jobId)
    if (!visit || visit.customerId !== draft.customerId || !['booked', 'completed'].includes(visit.state)) invalid('Choose a booked or completed visit for this customer.')
    if (Object.values(ws.invoices).some((inv) => inv.jobId === visit.id && inv.kind !== 'deposit' && !['CANCELLED', 'REFUNDED'].includes(inv.status))) invalid('This visit already has an invoice.')
  } else {
    const start = Date.parse(fields.start), end = Date.parse(fields.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now || end - start > 8 * 3600000) invalid('Enter the completed visit start and end. Use at most eight hours.')
    let id = nextId(ws, 'j')
    while (job(ws, id)) id = nextId(ws, 'j')
    visit = { id, customerId: draft.customerId, summary: draft.summary, start: new Date(start).toISOString(), end: new Date(end).toISOString(), state: 'completed', hours: (end - start) / 3600000 }
    ws.jobs.push(visit)
  }
  draft.jobId = visit.id
  draft.priced = balancePrice(ws, visit.id, draft.priced)
  return visit
}
