// The reminders PayPal will send by itself for each open invoice, as calendar events. PayPal keeps the setting per
// account (after the due date, every N days, M times); the Worker passes the numbers it was set to. An invoice is due
// on receipt, so the count starts the day it was sent. Shared by the Bryntum Calendar and the unit tests.

const DAY = 86_400_000
const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID'])

/**
 * @param {{ invoices?: Record<string, any>, reminders?: { everyDays: number, times: number, since: string } | null, now: number, tz?: number }} data
 * @returns {Array<{ id: string, invoiceId: string, customerId: string, start: number, end: number }>}
 */
export function plannedReminders(data) {
  const plan = data.reminders
  if (!plan) return []
  const since = Date.parse(plan.since)
  const tz = (data.tz || 0) * 60_000
  const out = []
  for (const inv of Object.values(data.invoices || {})) {
    if (inv.kind === 'deposit' || inv.remindersStopped || !OPEN.has(inv.status) || !inv.sentAt || inv.sentAt < since) continue
    const sentDay = Math.floor((inv.sentAt + tz) / DAY) * DAY
    for (let k = 1; k <= plan.times; k += 1) {
      // The whole local day PayPal sends it on: PayPal does not say the hour.
      const start = sentDay + k * plan.everyDays * DAY - tz
      if (start + DAY <= data.now) continue
      out.push({ id: `rem-${inv.id}-${k}`, invoiceId: inv.id, customerId: inv.customerId, start, end: start + DAY })
    }
  }
  return out
}
