// @ts-check
// One place where an invoice's money state changes the workspace, whoever saw it first: the webhook, the page's
// status poll, a recorded cash payment, or a hold that ran out. A second report of the same state is a no op.

import { customer, job, pushNotice } from './workspace.js'
import { depositPaid, invoiceCancelled } from './holds.js'

export const PAID = new Set(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'])
const TERMINAL = new Set(['CANCELLED', 'REFUNDED'])

/**
 * @param {any} ws @param {string} invoiceId @param {string} status @param {number} now
 * PayPal sends INVOICING.INVOICE.PAID for a part payment too ("An invoice is paid, partially paid, or payment is made
 * and is pending", PayPal's webhook event names page, read 28 Oct 2026), so a part payment arrives as PARTIALLY_PAID
 * with what is left. paid and tip are PayPal's running totals: paid includes the tip.
 * @param {{ due?: string, paid?: string, tip?: string, refunded?: string, source?: string }} [o]
 * @returns {boolean} whether anything changed
 */
export function applyStatus(ws, invoiceId, status, now, o = {}) {
  const inv = ws.invoices[invoiceId]
  if (!inv) return false
  if (TERMINAL.has(inv.status)) return false
  if (status === 'PARTIALLY_REFUNDED') {
    if (cents(o.refunded) < (cents(inv.refunded) || 0)) return false
    const changed = inv.status !== status || inv.refunded !== o.refunded || inv.paid !== o.paid || inv.due !== o.due
    inv.status = status
    if (o.due != null) inv.due = o.due
    if (o.paid != null) inv.paid = o.paid
    if (o.refunded != null) inv.refunded = o.refunded
    if (o.tip != null) inv.tip = o.tip
    const live = ws.holds.find((h) => h.invoiceId === invoiceId && !h.ended)
    if (live) live.ended = 'paid'
    const j = inv.jobId ? job(ws, inv.jobId) : undefined
    if (j && inv.kind === 'deposit') {
      if (Number.isFinite(cents(inv.paid)) && Number.isFinite(cents(inv.refunded))) j.depositPaid = cents(inv.paid) > cents(inv.refunded)
      if (['draft', 'held', 'booked'].includes(j.state)) j.state = 'booked'
    }
    else if (j) j.state = 'part_refunded'
    return changed
  }
  if (inv.status === 'PARTIALLY_REFUNDED' && status !== 'REFUNDED') return false
  const wasPaid = PAID.has(inv.status)
  if (PAID.has(status)) {
    if (wasPaid) return false
    const live = ws.holds.find((h) => h.invoiceId === invoiceId && !h.ended)
    if (live) {
      depositPaid(ws, invoiceId, now)
    } else {
      const j = inv.jobId ? job(ws, inv.jobId) : undefined
      if (j && inv.kind !== 'deposit') j.state = 'paid'
      if (j && inv.kind === 'deposit') { j.state = 'booked'; j.depositPaid = true; j.depositInvoiceId = invoiceId }
      const tip = cents(o.tip) > 0 ? ` plus a ${o.tip} tip` : ''
      pushNotice(ws, { at: now, kind: 'paid', invoiceId, text: `${customer(ws, inv.customerId)?.name || 'A customer'} paid ${inv.total}${inv.cash ? ' in cash' : ''}${tip}.` })
    }
    inv.status = status
    inv.due = '0.00'
    inv.paidAt = now
    if (o.paid) inv.paid = o.paid
    if (cents(o.tip) > 0) inv.tip = o.tip
    if (o.source) inv.paidBy = o.source
    return true
  }
  if (status === 'PARTIALLY_PAID' && !wasPaid && o.due != null && o.paid != null) {
    const paid = cents(o.paid), due = cents(o.due), tip = cents(o.tip) || 0
    if (!Number.isFinite(paid) || !Number.isFinite(due) || paid < 0 || due < 0 || tip < 0 || tip > paid) return false
    // Cumulative payment reports can arrive out of order. Refunds use their own branch above.
    if (paid < (cents(inv.paid) || 0) || paid - tip < (cents(inv.paid) || 0) - (cents(inv.tip) || 0) ||
      (inv.status === status && due > cents(inv.due))) return false
    if (inv.status === status && cents(inv.due) === cents(o.due)) return false
    const tipNow = Math.max(0, cents(o.tip) || 0)
    const part = (cents(o.paid) - tipNow) - ((cents(inv.paid) || 0) - (cents(inv.tip) || 0))
    const newTip = tipNow - (cents(inv.tip) || 0)
    const name = customer(ws, inv.customerId)?.name || 'A customer'
    pushNotice(ws, { at: now, kind: 'part', invoiceId, text: `${name} paid ${money(part)}${newTip > 0 ? ` plus a ${money(newTip)} tip` : ''}. ${o.due} left.` })
    const j = inv.jobId ? job(ws, inv.jobId) : undefined
    if (j && inv.kind !== 'deposit') j.state = 'part'
    inv.status = status
    inv.due = o.due
    inv.paid = o.paid
    if (tipNow > 0) inv.tip = o.tip
    return true
  }
  if (status === 'CANCELLED' || status === 'REFUNDED') {
    // A paid invoice is never cancelled by a late event; only a refund changes it.
    if (inv.status === 'CANCELLED' || (wasPaid && status === 'CANCELLED')) return false
    const live = ws.holds.find((h) => h.invoiceId === invoiceId && !h.ended)
    if (live) invoiceCancelled(ws, invoiceId, now)
    const j = inv.jobId ? job(ws, inv.jobId) : undefined
    if (j) {
      if (inv.kind === 'deposit') { j.depositPaid = false; if (j.state === 'held') j.state = 'released' }
      else if (j.invoiceId === invoiceId) j.state = status === 'REFUNDED' ? 'refunded' : 'cancelled'
    }
    inv.status = status
    inv.due = '0.00'
    if (o.refunded != null) inv.refunded = o.refunded
    if (o.paid != null) inv.paid = o.paid
    return true
  }
  if (status && status !== inv.status && !wasPaid) {
    // Unpaid reports cannot undo known payment progress. Refunds are handled above.
    if (inv.status === 'PARTIALLY_PAID' || cents(inv.paid) > 0 || status === 'PARTIALLY_PAID') return false
    inv.status = status
    if (o.due) inv.due = o.due
    return true
  }
  return false
}

/** Money text to whole cents; missing is NaN. @param {any} v */
const cents = (v) => (v == null || v === '' ? NaN : Math.round(Number(v) * 100))
/** @param {number} c */
const money = (c) => (c / 100).toFixed(2)
