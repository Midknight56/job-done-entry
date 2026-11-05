// @ts-check
// The reminder tap sends standard provider wording. Custom drafts are for manual use.

import { cancelReminders, remindInvoice } from '../paypal/invoices.js'
import { scrubText } from '../agent/guard.js'
import { customer, pushNotice } from '../state/workspace.js'

const DAY = 86_400_000
const REMINDABLE = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED', 'PAYMENT_PENDING'])

/** @param {string} text @param {{ due: string, sentAt?: number }} inv @param {number} now */
export function cleanReminder(text, inv, now) {
  const days = inv.sentAt ? Math.floor((now - inv.sentAt) / DAY) : 0
  return scrubText(String(text || '').slice(0, 1000), { results: [{ tool: 'invoice', result: { due: inv.due, days } }], transcript: '' }).text
}

/**
 * @param {any} ws @param {string} invoiceId @param {string} text
 * @param {{ api: any, now: number }} deps
 */
export async function sendReminderTap(ws, invoiceId, text, { api, now }) {
  const inv = ws.invoices[invoiceId]
  if (!inv) throw Object.assign(new Error('No such invoice in this workspace.'), { code: 'NOT_FOUND', status: 404 })
  if (!REMINDABLE.has(inv.status)) throw Object.assign(new Error('This invoice is paid or cancelled, so no reminder was sent.'), { code: 'NOT_REMINDABLE', status: 409 })
  const n = (inv.reminders || 0) + 1
  await remindInvoice(api, invoiceId, {}, `jd-${ws.id}-${invoiceId}-remind-${n}`)
  inv.reminders = n
  pushNotice(ws, { at: now, kind: 'reminder', invoiceId, text: `Reminder sent to ${customer(ws, inv.customerId)?.name || 'the customer'}.` })
}

/**
 * Stops the reminders PayPal would send by itself for one invoice. The calendar's planned reminders for it go away.
 * @param {any} ws @param {string} invoiceId @param {{ api: any, now: number }} deps
 */
export async function stopPayPalReminders(ws, invoiceId, { api }) {
  const inv = ws.invoices[invoiceId]
  if (!inv) throw Object.assign(new Error('No such invoice in this workspace.'), { code: 'NOT_FOUND', status: 404 })
  if (!REMINDABLE.has(inv.status)) throw Object.assign(new Error('This invoice is paid or cancelled, so PayPal sends no reminders for it.'), { code: 'NOT_REMINDABLE', status: 409 })
  if (inv.remindersStopped) return
  await cancelReminders(api, invoiceId, `jd-${ws.id}-${invoiceId}-stop-reminders`)
  inv.remindersStopped = true
}
