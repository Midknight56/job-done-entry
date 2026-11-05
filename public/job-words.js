import { paymentState } from './payment-state.js'

/** The state and money words used by both calendars. */
export function jobWords(job, data) {
  const hold = data.holds?.find((item) => item.jobId === job.id && !item.ended)
  const offer = Object.values(data.offers || {}).some((item) => item.jobId === job.id && !item.accepted)
  const invoice = data.invoices?.[job.invoiceId]
  const deposit = data.invoices?.[job.depositInvoiceId || hold?.invoiceId]
  const settlement = data.settlements?.[job.settlementId]
  let state = hold ? 'held' : offer ? 'offered' : job.state
  if (state === 'sent' && invoice?.sentAt && data.now - invoice.sentAt > (data.settings?.lateDays ?? 7) * 86400000) state = 'late'
  const amount = Number(deposit?.total ?? data.settings?.rateCard?.deposit ?? 0).toFixed(2)
  const words = settlement ? 'Complete, paid by deposit'
    : invoice?.status === 'PARTIALLY_REFUNDED' ? paymentState(invoice).label
    : state === 'booked' && deposit?.status === 'PARTIALLY_REFUNDED' ? `Deposit ${paymentState(deposit).label.toLowerCase()}`
    : invoice?.status === 'PARTIALLY_PAID' ? `Part paid, ${Number(invoice.due).toFixed(2)} left`
    : ['REFUNDED', 'CANCELLED'].includes(invoice?.status) ? (invoice.status === 'REFUNDED' ? 'Refunded' : 'Invoice cancelled')
    : state === 'booked' && deposit?.status === 'REFUNDED' ? 'Deposit refunded'
    : state === 'booked' && deposit?.status === 'CANCELLED' ? 'Deposit cancelled'
    : state === 'held' ? `Held, deposit ${amount}`
    : state === 'booked' && job.depositPaid ? 'Deposit paid'
    : ({ booked: 'Booked', completed: 'Completed', part: 'Part paid', cancelled: 'Invoice cancelled', refunded: 'Refunded', offered: 'Offered', sent: 'Invoice sent', late: 'Late', paid: 'Paid', released: 'Released' }[state] || state)
  const remaining = hold ? Math.max(0, Math.floor((hold.expiresAt - data.now) / 1000)) : 0
  return {
    state,
    words,
    line: hold ? `${words}, ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : words,
    amount: settlement ? `Applied ${settlement.depositCredit}${Number(settlement.depositSurplus) > 0 ? `. Surplus ${settlement.depositSurplus} needs resolution` : ''}`
      : invoice ? `Invoice ${Number(invoice.total || 0).toFixed(2)}` : (hold && hold.expiresAt > data.now) || job.depositPaid || deposit ? `Deposit ${amount}` : ''
  }
}

/** A tap opens details beneath either calendar. */
export function jobDetails(host) {
  const panel = document.createElement('section')
  panel.className = 'job-details'
  panel.setAttribute('aria-label', 'Job details')
  panel.hidden = true
  host.after(panel)
  let selected
  function render(data) {
    const job = data.jobs.find((item) => item.id === selected)
    if (!job) { panel.hidden = true; selected = null; return }
    const close = document.createElement('button')
    close.textContent = 'Close'
    close.onclick = () => { selected = null; panel.hidden = true }
    const name = document.createElement('h3')
    name.textContent = data.customers.find((person) => person.id === job.customerId)?.name || ''
    const time = document.createElement('p')
    const localTime = (value) => new Date(Date.parse(value) + (data.tz || 0) * 60000).toLocaleString([], { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })
    time.textContent = `${localTime(job.start)} to ${localTime(job.end)}`
    const summary = document.createElement('p')
    summary.textContent = job.summary
    const status = document.createElement('p')
    const words = jobWords(job, data)
    status.textContent = [words.line, words.amount].filter(Boolean).join('. ')
    panel.replaceChildren(close, name, time, summary, status)
    panel.hidden = false
  }
  return {
    render,
    toggle(id, data) {
      selected = selected === id ? null : id
      render(data)
      if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' })
    },
    destroy: () => panel.remove()
  }
}
