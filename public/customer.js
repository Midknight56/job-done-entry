import { paymentState } from './payment-state.js'
// Loads a customer invoice and polls its payment status.
const invoiceId = new URLSearchParams(location.search).get('inv')

/** Loads invoice state and refreshes the payment status. */
async function updateInvoice() {
  try {
    const response = await fetch('/api/state')
    if (!response.ok) return
    const state = await response.json()
    const invoice = state.ws.invoices[invoiceId]
    if (!invoice) return
    document.querySelector('#business').textContent = state.ws.settings.business
    const { paid, closed, label } = paymentState(invoice)
    const amount = paid ? invoice.total : invoice.due || invoice.total
    document.querySelector('#amount').textContent = Number(amount).toFixed(2)
    const image = document.querySelector('#qr')
    image.hidden = closed || !invoice.hasQr || invoice.shared
    document.querySelector('#payment-help').hidden = closed
    document.querySelector('#shared').hidden = !invoice.shared
    if (!image.hidden && image.dataset.invoiceId !== invoiceId) {
      image.src = `/api/qr/${encodeURIComponent(invoiceId)}`
      image.dataset.invoiceId = invoiceId
    }
    const status = document.querySelector('#status')
    status.textContent = label
    status.className = `pay-status ${paid ? 'paid-status' : 'waiting-status'}`
  } catch {}
}

updateInvoice()
setInterval(updateInvoice, 3000)
