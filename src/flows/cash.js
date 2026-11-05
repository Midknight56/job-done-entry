// @ts-check
// The cash tap: "Dave paid cash, 108" becomes a CASH payment recorded on the invoice. The amount is checked against
// the live due amount from PayPal before anything is written.

import { getInvoice, recordCash } from '../paypal/invoices.js'
import { toCents } from '../pricing/ratecard.js'
import { applyStatus, PAID } from '../state/money.js'

/** @param {string} code @param {string} message @param {number} [status] */
const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status })

/**
 * @param {any} ws @param {string} invoiceId @param {string} amount
 * @param {{ api: any, now: number }} deps
 */
export async function recordCashTap(ws, invoiceId, amount, { api, now }) {
  const inv = ws.invoices[invoiceId]
  if (!inv) throw fail('NOT_FOUND', 'No such invoice in this workspace.', 404)
  if (inv.shared) throw fail('SHARED', 'This late invoice is shared by every demo, so it cannot be paid here.')
  const live = await getInvoice(api, invoiceId)
  if (PAID.has(live.status) || live.status === 'CANCELLED' || ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(live.status)) throw fail('CASH_CLOSED', 'This invoice is no longer open for cash payment.')
  const cents = toCents(amount)
  if (!(cents > 0)) throw fail('CASH_BAD', 'That amount is not a number.')
  if (cents > toCents(live.due)) throw fail('CASH_TOO_HIGH', `Only ${live.due} is due on this invoice.`)
  // The payment date may not be after the merchant's today or before the invoice's date. Twelve hours behind UTC is
  // never after the merchant's today; the invoice's own date is used when it is later.
  const behind = new Date(now - 12 * 3_600_000).toISOString().slice(0, 10)
  const date = live.invoiceDate && live.invoiceDate > behind ? live.invoiceDate : behind
  await recordCash(api, invoiceId, { amount: (cents / 100).toFixed(2), currency: live.currency || 'USD', date, note: 'Paid in cash on site.' }, `jd-${ws.id}-${invoiceId}-cash-${cents}`)
  inv.cash = true
  const after = await getInvoice(api, invoiceId)
  applyStatus(ws, invoiceId, after.status, now, {
    due: after.due, paid: after.paid, tip: after.tip, refunded: after.refunded, source: 'cash',
  })
  return { status: inv.status, due: inv.due }
}
