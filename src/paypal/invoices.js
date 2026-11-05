// @ts-check
// The PayPal Invoicing calls, with the shapes seen in the sandbox on 22 Oct 2026 (docs/DAY-ONE.md):
// create answers 201 with only a link, so the id is read from the end of its href; send answers 200; remind and
// cancel answer 204; recording cash answers 200 and the status becomes MARKED_AS_PAID; the QR code comes as
// multipart/form-data with one part holding a base64 PNG.

export class PayPalError extends Error {
  /** @param {string} what @param {{ status: number, debugId?: string, errorName?: string }} res */
  constructor(what, res) {
    super(`${what}: HTTP ${res.status}${res.errorName ? ' ' + res.errorName : ''}`)
    this.code = 'PAYPAL'
    this.status = res.status
    this.debugId = res.debugId
    this.errorName = res.errorName
  }
}

export class RecipientError extends Error {
  constructor() {
    super('This demo only sends to PayPal sandbox test accounts and example.com addresses.')
    this.code = 'RECIPIENT'
    this.status = 422
  }
}

/**
 * A recipient is allowed only when it is a sandbox persona held in the Worker's secrets or an address at example.com,
 * so no real person can get an email from the demo.
 * @param {string} email @param {any} env @returns {string} the address to send to
 */
export function resolveRecipient(email, env) {
  if (email.startsWith('persona:')) {
    const name = email.slice('persona:'.length).toUpperCase()
    const address = env[`PAYPAL_${name}_EMAIL`]
    if (!address) throw new RecipientError()
    return address
  }
  if (/^[^@\s]+@example\.com$/i.test(email)) return email
  throw new RecipientError()
}

/** @param {{ href?: string, id?: string } | null} json */
export function idFromLink(json) {
  if (!json) return null
  if (json.id) return json.id
  const m = /\/invoices\/([A-Z0-9-]+)$/.exec(json.href || '')
  return m ? m[1] : null
}

/**
 * No invoice or item date is sent: PayPal then dates the invoice by its own clock. A date from this server's clock
 * can be tomorrow for the merchant, and PayPal then holds the invoice as SCHEDULED (seen 22 Oct 2026: send answered
 * 202 and the status was SCHEDULED).
 * The invoice number is fixed per draft. PayPal refuses a second invoice with the same number
 * (422 DUPLICATE_INVOICE_NUMBER, seen 23 Oct 2026), which is what stops two taps making two invoices: the Invoicing API
 * does not honour PayPal-Request-Id (two creates with one request id made two invoices, the same night).
 * A tip and a part payment (at least partMinimum now, the rest later) were accepted by the sandbox in this shape on
 * 28 Oct 2026, and PayPal's pay page then offered both (docs/STATE.md).
 * @param {{ business: string, given: string, surname: string, email: string, priced: any, reference: string, note?: string, invoiceNumber?: string, allowTip?: boolean, partMinimum?: string }} o
 */
export function invoiceBody(o) {
  if (Number(o.priced.depositCredit) > 0) {
    o = { ...o, note: `${o.note || 'Thank you.'} Job price ${o.priced.jobTotal}. Paid deposit ${o.priced.depositCredit}. Balance ${o.priced.total}.`,
      priced: { ...o.priced, taxPercent: '0', lines: [{ name: 'Remaining job balance', quantity: '1', unitAmount: o.priced.total, uom: 'AMOUNT' }] } }
  }
  const taxed = Number(o.priced.taxPercent) > 0
  return {
    detail: {
      currency_code: o.priced.currency,
      ...(o.invoiceNumber ? { invoice_number: o.invoiceNumber } : {}),
      reference: o.reference,
      note: o.note || 'Thank you.',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    invoicer: { business_name: o.business },
    primary_recipients: [{ billing_info: { name: { given_name: o.given, surname: o.surname }, email_address: o.email } }],
    items: o.priced.lines.map((l) => ({
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
      quantity: l.quantity,
      unit_amount: { currency_code: o.priced.currency, value: l.unitAmount },
      ...(taxed ? { tax: { name: 'Sales tax (demo rate)', percent: o.priced.taxPercent } } : {}),
      unit_of_measure: l.uom,
    })),
    configuration: {
      allow_tip: Boolean(o.allowTip),
      ...(o.partMinimum ? { partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: o.priced.currency, value: o.partMinimum } } } : {}),
    },
  }
}

// Hosts a create link may name. PayPal's links use api.sandbox.paypal.com (read from a sandbox search, 23 Oct 2026),
// not the api-m host the app sends its requests to.
const PAYPAL_HOSTS = ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com', 'api.paypal.com', 'api-m.paypal.com']

/**
 * Creates the invoice, or finds the one already made with this invoice number (a second tap, or a retry after a
 * failure part way through).
 * @param {any} api @param {any} body @param {string} requestId
 */
export async function createInvoice(api, body, requestId) {
  const res = await api.request({ method: 'POST', path: '/v2/invoicing/invoices', body, requestId })
  const href = res.json?.href
  let trustedHref = false
  if (href) {
    try {
      const url = new URL(href)
      trustedHref = url.protocol === 'https:' && PAYPAL_HOSTS.includes(url.hostname)
    } catch {}
  }
  const id = res.ok ? (res.json?.id || (trustedHref ? idFromLink(res.json) : null)) : null
  if (id) return id
  const duplicate = res.status === 422 && (res.json?.details || []).some((d) => d.issue === 'DUPLICATE_INVOICE_NUMBER')
  if (duplicate && body.detail?.invoice_number) {
    const found = await findByNumber(api, body.detail.invoice_number)
    if (found) return found
  }
  throw new PayPalError('Create invoice', res)
}

/** @param {any} api @param {string} number */
export async function findByNumber(api, number) {
  const res = await api.request({ method: 'POST', path: '/v2/invoicing/search-invoices?page=1&page_size=1', body: { invoice_number: number }, label: '/v2/invoicing/search-invoices' })
  return res.ok ? res.json?.items?.[0]?.id || null : null
}

/**
 * Sends a draft. A send that fails because another tap already sent it is not an error.
 * @param {any} api @param {string} id @param {string} requestId @param {string} [note]
 */
export async function sendInvoice(api, id, requestId, note) {
  const res = await api.request({ method: 'POST', path: `/v2/invoicing/invoices/${id}/send`, body: { send_to_recipient: true, ...(note ? { note } : {}) }, requestId })
  if (res.ok) return
  const now = await getInvoice(api, id).catch(() => null)
  if (now && now.status !== 'DRAFT') return
  throw new PayPalError('Send invoice', res)
}

/** The QR code as a base64 PNG, or null when PayPal did not give one. @param {any} api @param {string} id @param {string} requestId */
export async function invoiceQr(api, id, requestId) {
  const res = await api.request({ method: 'POST', path: `/v2/invoicing/invoices/${id}/generate-qr-code`, body: { width: 300, height: 300 }, requestId, accept: '*/*' })
  if (!res.ok) return null
  if ('contentType' in res && !res.contentType?.toLowerCase().includes('multipart/form-data')) return null
  return qrFromMultipart(res.text)
}

/** @param {string} text */
export function qrFromMultipart(text) {
  const start = text.indexOf('\r\n\r\n')
  if (start < 0) return /^[A-Za-z0-9+/=\s]+$/.test(text) ? text.trim() : null
  const part = text.slice(start + 4).split('\r\n--')[0].trim()
  return part.startsWith('iVBOR') ? part : null
}

/** @param {any} api @param {string} id */
export async function getInvoice(api, id) {
  const res = await api.request({ method: 'GET', path: `/v2/invoicing/invoices/${id}` })
  if (!res.ok) throw new PayPalError('Read invoice', res)
  if (!res.json || typeof res.json !== 'object' || Array.isArray(res.json)) throw new PayPalError('Read invoice', { ...res, status: 502, errorName: 'INVALID_RESPONSE' })
  return readInvoice(res.json)
}

/** The fields the app reads, seen in tests/fixtures/invoice-sent.json and invoice-partially_paid.json. @param {any} j */
export function readInvoice(j) {
  return {
    id: j.id,
    status: j.status,
    total: j.amount?.value,
    due: j.due_amount?.value ?? j.amount?.value,
    paid: j.payments?.paid_amount?.value,
    tip: j.gratuity?.value,
    refunded: j.refunds?.refund_amount?.value,
    currency: j.amount?.currency_code,
    reference: j.detail?.reference,
    payerUrl: j.detail?.metadata?.recipient_view_url,
    sentAt: j.detail?.metadata?.first_sent_time,
    dueDate: j.detail?.payment_term?.due_date,
    invoiceDate: j.detail?.invoice_date,
  }
}

/** @param {any} api @param {string} id @param {{ amount: string, currency: string, date: string, note?: string }} p @param {string} requestId */
export async function recordCash(api, id, p, requestId) {
  const res = await api.request({
    method: 'POST',
    path: `/v2/invoicing/invoices/${id}/payments`,
    body: { method: 'CASH', payment_date: p.date, amount: { currency_code: p.currency, value: p.amount }, note: p.note || 'Paid in cash.' },
    requestId,
  })
  if (!res.ok) throw new PayPalError('Record cash', res)
}

/** @param {any} api @param {string} id @param {{ subject?: string, note?: string }} p @param {string} requestId */
export async function remindInvoice(api, id, p, requestId) {
  const res = await api.request({ method: 'POST', path: `/v2/invoicing/invoices/${id}/remind`, body: { send_to_recipient: true }, requestId })
  if (!res.ok) throw new PayPalError('Send reminder', res)
}

/** @param {any} api @param {string} id @param {string} note @param {string} requestId */
export async function cancelInvoice(api, id, note, requestId) {
  const res = await api.request({ method: 'POST', path: `/v2/invoicing/invoices/${id}/cancel`, body: { send_to_recipient: true, note }, requestId })
  if (!res.ok) throw new PayPalError('Cancel invoice', res)
}

/**
 * PayPal's own reminders run per account (one BEFORE_DUE and one AFTER_DUE setting). The maintainer sets the AFTER_DUE
 * one with tools/sandbox_probe.py (reminders-on) and writes the same numbers in the Worker's settings, so the page can
 * show what PayPal will send without asking PayPal on every request; /health?deep=1 compares the two.
 * @param {any} env @returns {{ everyDays: number, times: number, since: string } | null}
 */
export function reminderPlan(env) {
  const everyDays = Number(env?.PAYPAL_REMINDER_EVERY_DAYS)
  const times = Number(env?.PAYPAL_REMINDER_TIMES)
  const since = String(env?.PAYPAL_REMINDERS_SINCE || '')
  if (!Number.isInteger(everyDays) || everyDays < 1 || !Number.isInteger(times) || times < 1 || Number.isNaN(Date.parse(since))) return null
  return { everyDays, times, since }
}

/** Stops PayPal's automatic reminders for one invoice; answers 204 (sandbox, 28 Oct 2026). @param {any} api @param {string} id @param {string} requestId */
export async function cancelReminders(api, id, requestId) {
  const res = await api.request({ method: 'POST', path: `/v2/invoicing/invoices/${id}/cancel-reminders`, body: {}, requestId })
  if (!res.ok) throw new PayPalError('Stop reminders', res)
}

/** The account's AFTER_DUE setting as PayPal holds it, or null. @param {any} api */
export async function readAfterDueReminder(api) {
  const res = await api.request({ method: 'GET', path: '/v2/invoicing/reminders' })
  if (!res.ok) throw new PayPalError('Read reminders', res)
  const c = (res.json?.configurations || []).find((x) => x.type === 'AFTER_DUE')
  return c ? { status: c.status, everyDays: c.interval?.value, times: c.repetition } : null
}
