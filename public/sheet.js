import { paymentState } from './payment-state.js'
// Opens invoice payment sheets and refreshes their live status with workspace state.
let activeInvoice
let qrUrl
let qrMessage
let opener
let stopReminders = async () => {}
let keepSheet = () => () => {}

/** Shares focus and pending action handling with the page. */
export function setSheetKeeper(fn) {
  keepSheet = fn
}

/** The page gives the call that stops PayPal's reminders for one invoice and shows the new state. */
export function setReminderStopper(fn) {
  stopReminders = fn
}

function closeSheet() {
  const sheet = document.querySelector('#sheet')
  if (!sheet || (sheet.hidden && !activeInvoice)) return
  sheet.hidden = true
  delete sheet.dataset.invoiceId
  activeInvoice = null
  qrUrl = null
  qrMessage = null
  document.removeEventListener('keydown', onKeydown)
  opener?.focus()
  opener = null
}

function onKeydown(event) {
  if (event.key === 'Escape') closeSheet()
}

function safePayerUrl(value) {
  try {
    const url = new URL(value)
    return url.origin === 'https://www.sandbox.paypal.com' && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Opens the payment sheet and loads the invoice QR when one is available. */
export async function openInvoiceSheet(invoiceId, state, request) {
  if (!activeInvoice) opener = document.activeElement
  document.addEventListener('keydown', onKeydown)
  activeInvoice = invoiceId
  qrUrl = null
  qrMessage = null
  updateInvoiceSheet(state)
  const invoice = state.ws.invoices[invoiceId]
  if (invoice?.hasQr && !invoice.shared && !paymentState(invoice).closed) {
    try {
      const image = await request(`/api/qr/${encodeURIComponent(invoiceId)}`)
      if (activeInvoice === invoiceId) qrUrl = URL.createObjectURL(image)
    } catch (error) {
      qrMessage = error?.message || 'No connection. Try again.'
    }
  }
  updateInvoiceSheet(state)
}

/** Updates visible invoice details and live payment status. */
export function updateInvoiceSheet(state) {
  const sheet = document.querySelector('#sheet')
  if (!sheet || !activeInvoice) return
  const invoice = state?.ws.invoices?.[activeInvoice]
  const settlement = state?.ws.settlements?.[activeInvoice]
  if (settlement) {
    sheet.hidden = false
    sheet.dataset.invoiceId = activeInvoice
    const restore = keepSheet(sheet)
    sheet.replaceChildren()
    const add = (tag, text) => {
      const element = document.createElement(tag)
      element.textContent = text
      sheet.append(element)
      return element
    }
    const close = add('button', 'Close')
    close.className = 'sheet-close'
    close.onclick = closeSheet
    add('h2', 'Job complete')
    add('p', state.ws.customers.find(person => person.id === settlement.customerId)?.name || '')
    add('p', settlement.summary)
    add('p', `Receipt ${settlement.id}`)
    add('p', `Deposit invoice ${settlement.depositInvoiceId}`)
    const money = value => Number(value).toFixed(2)
    add('p', `Job price ${money(settlement.jobTotal)}`)
    add('p', `Paid deposit ${money(settlement.depositTotal)}`)
    if (Number(settlement.depositRetained) < Number(settlement.depositTotal)) add('p', `Deposit retained ${money(settlement.depositRetained)}`)
    add('p', `Applied credit ${money(settlement.depositCredit)}`)
    add('p', 'Remaining balance 0.00')
    if (Number(settlement.depositSurplus) > 0) {
      add('p', `Surplus to resolve ${money(settlement.depositSurplus)}`)
      add('p', 'Agree how to return or use the surplus.')
    }
    const done = add('button', 'Done')
    done.className = 'primary sheet-done'
    done.onclick = closeSheet
    restore()
    return
  }
  if (!invoice) {
    closeSheet()
    return
  }
  sheet.hidden = false
  sheet.dataset.invoiceId = activeInvoice
  const restore = keepSheet(sheet)
  sheet.replaceChildren()
  const close = document.createElement('button')
  close.className = 'sheet-close'
  close.textContent = 'Close'
  close.onclick = closeSheet
  const heading = document.createElement('h2')
  heading.textContent = state.ws.settings.business
  const customer = document.createElement('p')
  customer.textContent = state.ws.customers.find((person) => person.id === invoice.customerId)?.name || ''
  const amount = document.createElement('div')
  amount.className = 'money'
  const { paid, closed, label } = paymentState(invoice)
  amount.textContent = Number(paid ? invoice.total : invoice.due || invoice.total || 0).toFixed(2)
  sheet.append(close, heading, customer, amount)
  const status = document.createElement('p')
  status.className = 'pay-status'
  if (paid) status.classList.add('paid-status')
  status.textContent = label
  sheet.append(status)
  if (Number(invoice.tip) > 0) {
    const tip = document.createElement('p')
    tip.className = 'centered tip-line'
    tip.textContent = `Tip ${Number(invoice.tip).toFixed(2)}`
    sheet.append(tip)
  }
  if (invoice.shared) {
    const shared = document.createElement('div')
    shared.className = 'quiet shared-invoice'
    shared.textContent = 'Shared invoice'
    sheet.append(shared)
  } else if (invoice.hasQr && !closed) {
    const qrCard = document.createElement('div')
    qrCard.className = 'qr-card'
    if (qrUrl) {
      const image = document.createElement('img')
      image.className = 'qr'
      image.alt = 'Payment QR code'
      image.src = qrUrl
      qrCard.append(image)
    } else {
      const loading = document.createElement('div')
      loading.className = 'quiet qr-loading'
      loading.textContent = qrMessage || 'Loading QR'
      qrCard.append(loading)
    }
    const scan = document.createElement('p')
    scan.className = 'centered'
    scan.textContent = 'Scan to pay with PayPal'
    qrCard.append(scan)
    sheet.append(qrCard)
  } else if (!invoice.shared && !closed) {
    const noQr = document.createElement('p')
    noQr.className = 'quiet'
    noQr.textContent = 'No QR this time. Use the link.'
    sheet.append(noQr)
  }
  const payerUrl = safePayerUrl(invoice.payerUrl)
  if (!invoice.shared && !closed && payerUrl) {
    const links = document.createElement('div')
    links.className = 'pay-links'
    const link = document.createElement('a')
    link.className = 'button pay-link'
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'Open the PayPal page'
    const customerLink = document.createElement('a')
    customerLink.className = 'button pay-link'
    customerLink.href = `./customer.html?inv=${encodeURIComponent(activeInvoice)}`
    customerLink.target = '_blank'
    customerLink.rel = 'noopener'
    customerLink.textContent = 'Open customer view'
    link.href = payerUrl
    links.append(link)
    links.append(customerLink)
    sheet.append(links)
  }
  // PayPal reminds unpaid invoices by itself (an account setting); this stops it for this one invoice.
  const remindable = ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(invoice.status) && invoice.kind !== 'deposit' && !invoice.shared
  if (state.reminders && remindable && invoice.sentAt >= Date.parse(state.reminders.since)) {
    if (invoice.remindersStopped) {
      const off = document.createElement('p')
      off.className = 'centered quiet'
      off.textContent = 'PayPal reminders off'
      sheet.append(off)
    } else {
      const stop = document.createElement('button')
      stop.className = 'stop-reminders'
      stop.textContent = 'Stop PayPal reminders'
      stop.onclick = async () => {
        stop.disabled = true
        try {
          await stopReminders(activeInvoice)
        } catch {
          stop.disabled = false
        }
      }
      sheet.append(stop)
    }
  }
  if (paid) {
    const done = document.createElement('button')
    done.className = 'primary sheet-done'
    done.textContent = 'Done'
    done.onclick = closeSheet
    sheet.append(done)
  }
  restore()
}
