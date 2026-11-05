// Renders the latest PayPal, model, and application activity entries.

const LABEL_PATTERNS = [
  { kind: 'paypal', method: 'POST', path: /^\/v2\/invoicing\/invoices$/, label: 'Create invoice' },
  { kind: 'paypal', path: /\/send$/, label: 'Send invoice' },
  { kind: 'paypal', path: /\/generate-qr-code$/, label: 'Make QR code' },
  { kind: 'paypal', method: 'GET', path: /^\/v2\/invoicing\/invoices\/[^/?]+$/, label: 'Read invoice' },
  { kind: 'paypal', path: /\/payments$/, label: 'Record cash' },
  { kind: 'paypal', path: /\/remind$/, label: 'Send reminder' },
  { kind: 'paypal', path: /\/cancel$/, label: 'Cancel invoice' },
  { kind: 'paypal', path: /^\/v2\/invoicing\/search-invoices(?:\?|$)/, label: 'Find invoice by number' },
  { kind: 'paypal', path: /^\/v1\/oauth2\/token$/, label: 'Get access token' },
  { kind: 'paypal', path: /^\/v1\/notifications\/verify-webhook-signature$/, label: 'Check webhook signature' },
  { kind: 'model', path: /whisper/i, label: 'Speech to text' },
  { kind: 'model', path: /^recorded output$/, label: 'Recorded AI step' },
  { kind: 'model', path: /^development stub$/, label: 'Stand in step' },
  { kind: 'model', label: 'AI step' },
]

function entryLabel(entry) {
  if (entry.kind === 'webhook') return `PayPal told us: ${entry.text || ''}`
  if (entry.kind === 'tool') return `Tool: ${entry.path || ''}`
  if (entry.kind === 'guard') return `Price check: ${String(entry.text || '').startsWith('dropped') ? 'dropped' : 'passed'}`
  return LABEL_PATTERNS.find(({ kind, method, path }) =>
    kind === entry.kind && (!method || method === entry.method) && (!path || path.test(entry.path || ''))
  )?.label || ''
}

/** Draws up to sixty panel entries, with the newest at the top. */
export function renderPanel(element, entries = []) {
  element.replaceChildren()
  const list = document.createElement('div')
  list.className = 'panel-list'
  const recent = [...entries].slice(-60).reverse()
  recent.forEach((entry) => {
    const row = document.createElement('article')
    row.className = 'panel-entry'
    row.dataset.kind = entry.kind || 'tool'
    const header = document.createElement('div')
    header.className = 'panel-head'
    const time = document.createElement('span')
    time.textContent = new Date(entry.at || Date.now()).toLocaleTimeString([], { hour12: false })
    const kind = document.createElement('span')
    kind.className = 'kind-tag'
    kind.textContent = entry.kind || 'tool'
    const status = document.createElement('span')
    const statusColor = entry.status >= 500 ? 'red' : entry.status >= 400 ? 'amber' : 'green'
    status.className = `status-pill ${statusColor}`
    status.textContent = entry.status ?? 'N/A'
    header.append(time, kind, status)
    if (typeof entry.ms === 'number') {
      const duration = document.createElement('span')
      duration.textContent = `${entry.ms} ms`
      header.append(duration)
    }
    if (entry.neurons != null) {
      const neurons = document.createElement('span')
      neurons.textContent = `${entry.neurons} neurons`
      header.append(neurons)
    }
    const path = document.createElement('div')
    path.className = 'panel-path'
    path.textContent = `${entry.method || ''} ${entry.path || ''}`
    const labelText = entryLabel(entry)
    let label
    if (labelText) {
      label = document.createElement('div')
      label.className = 'panel-label'
      label.textContent = labelText
    }
    row.append(header)
    if (label) row.append(label)
    row.append(path)
    for (const value of [entry.id, entry.debugId, entry.text]) {
      if (!value) continue
      const detail = document.createElement('div')
      detail.className = 'panel-extra'
      detail.textContent = value
      row.append(detail)
    }
    list.append(row)
    if (!entry._seen) {
      requestAnimationFrame(() => row.classList.add('flash'))
      entry._seen = true
    }
  })
  element.append(list)
}
