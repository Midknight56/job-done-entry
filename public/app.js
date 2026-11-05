// Loads workspace state, routes tabs, and coordinates the phone interface.
import { renderPanel } from './panel.js'
import { renderProposal } from './cards.js'
import { openInvoiceSheet, setReminderStopper, updateInvoiceSheet, setSheetKeeper } from './sheet.js'
import { setupTalk } from './talk.js'

// ?video=1 enlarges the phone and the panel to fill a 1920 x 1080 recording for the demo film.
if (new URLSearchParams(location.search).get('video') === '1') document.documentElement.classList.add('video')

const $ = (selector) => document.querySelector(selector)
const screen = $('#screen')
const calendarHost = $('#calendarHost')
const demoLines = [
  'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.',
  'Book the bathroom tap for Maria next week.',
  'Dave paid cash, 108.',
  'Remind Sam about his invoice.',
  'What am I owed?'
]
let calendarLoading
let state
let proposal
let focusedProposal
let message
let tab = 'today'
let calendar
let serverTime = 0
let clientTime = 0
let sendingText = false
let loading = true
let lastStateJson
const busyKeys = new Set()
let waitingFields = { customerId: '', summary: '', hours: '1', free: 'any' }
let waitingError = ''
let waitingEditId = null

/** Saves the focused control before its card is rebuilt. */
function keepFocus(root) {
  const control = document.activeElement
  if (!root?.contains(control) || !control.dataset.keep) return () => {}
  const key = control.dataset.keep
  const value = control.value
  const edited = value !== undefined && value !== control.defaultValue
  const start = control.selectionStart
  const end = control.selectionEnd
  const direction = control.selectionDirection
  return () => {
    const next = [...root.querySelectorAll('[data-keep]')].find((element) => element.dataset.keep === key)
    if (!next) return
    if (edited) next.value = value
    next.focus({ preventScroll: true })
    if (typeof start === 'number' && next.setSelectionRange) next.setSelectionRange(start, end, direction)
  }
}

/** Gives each control a stable key and keeps pending actions busy across polls. */
function keepControls(root, prefix) {
  const controls = [...root.querySelectorAll('button, input, textarea, select')]
  controls.forEach((control, index) => {
    control.dataset.keep ||= `${prefix}-${control.getAttribute('aria-label') || control.name || control.textContent.trim() || index}`
    const key = control.dataset.keep
    if (busyKeys.has(key)) control.disabled = true
    const handler = control.onclick
    if (!handler || control.dataset.busyBound) return
    control.dataset.busyBound = 'true'
    control.onclick = function (event) {
      if (busyKeys.has(key)) return
      const disabled = new Set(controls.filter((item) => item.disabled))
      const result = handler.call(this, event)
      if (!result?.then) return result
      const keys = controls.filter((item) => item.disabled && !disabled.has(item)).map((item) => item.dataset.keep)
      if (!keys.includes(key)) keys.push(key)
      keys.forEach((item) => busyKeys.add(item))
      control.disabled = true
      return result.finally(() => {
        keys.forEach((item) => busyKeys.delete(item))
        document.querySelectorAll('#screen [data-keep], #sheet [data-keep]').forEach((item) => {
          if (keys.includes(item.dataset.keep)) item.disabled = false
        })
      })
    }
  })
}

setSheetKeeper((root) => {
  const restore = keepFocus(root)
  return () => { keepControls(root, `sheet-${root.dataset.invoiceId}`); restore() }
})

/** Sends a request and parses JSON or an image response. */
async function request(path, options = {}) {
  let response
  try {
    response = await fetch(path, options)
  } catch {
    throw { message: 'No connection. Try again.' }
  }
  if (!response.ok) {
    let error
    try {
      error = await response.json()
    } catch {}
    throw { ...(error || { message: 'No connection. Try again.' }), status: response.status }
  }
  if (response.headers.get('content-type')?.includes('image/')) return response.blob()
  try {
    return await response.json()
  } catch {
    throw { message: 'Something went wrong. Try again.' }
  }
}

/** Sends a JSON POST request. */
function post(path, data) {
  return request(path, {
    method: 'POST',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  })
}

/** Escapes text before placing it in generated markup. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

/** Formats money to two decimal places. */
function money(value) {
  return Number(value || 0).toFixed(2)
}

/** Finds a customer name by identifier. */
function customer(id) {
  return state?.ws.customers.find((person) => person.id === id)?.name || id || ''
}

/** Updates state and redraws the visible screens. */
function setState(nextState, poll = false) {
  if (!validState(nextState)) throw { message: 'Something went wrong. Try again.' }
  const json = JSON.stringify(nextState)
  const unchanged = json === lastStateJson
  lastStateJson = json
  state = nextState
  if (!unchanged) {
    serverTime = Number(state?.now) || Date.now()
    clientTime = Date.now()
  }
  if (poll && unchanged) {
    if (tab === 'calendar' && calendar) calendar.render({ ...state.ws, now: serverTime + Date.now() - clientTime, reminders: state.reminders })
    return
  }
  $('#replayBar').hidden = !state?.budget?.replay
  renderPanels()
  render()
  updateInvoiceSheet(state)
}

/** Draws the activity panel for desktop and mobile. */
function renderPanels() {
  if (!state) return
  renderPanel($('#panel'), state.ws.panel || [])
  renderPanel($('#panelMobile'), state.ws.panel || [])
}

/** Shows a recoverable message on Today. */
function showError(error) {
  message = error?.message || 'No connection. Try again.'
  tab = 'today'
  render()
}

/** Loads state and creates the workspace when none exists. */
async function refresh() {
  const hadState = Boolean(state)
  loading = true
  if (!state) render()
  try {
    const watch = activeInvoiceId()
    const nextState = await request(`/api/state${watch ? `?watch=${encodeURIComponent(watch)}` : ''}`)
    if (!hadState) message = null
    setState(nextState, true)
  } catch (error) {
    if (['not_found', 'unauthorized'].includes(error?.error) || [404, 401].includes(error?.status)) {
      try {
        const nextState = await post('/api/workspace', { tz: -new Date().getTimezoneOffset() })
        if (!hadState) message = null
        setState(nextState)
      } catch (workspaceError) {
        showError(workspaceError)
      }
    } else {
      showError(error)
    }
  } finally {
    loading = false
    if (!state) render()
  }
}

/** Returns the invoice currently displayed in the payment sheet. */
function activeInvoiceId() {
  return document.querySelector('#sheet')?.hidden ? null : document.querySelector('#sheet')?.dataset.invoiceId
}

/** Draws the selected tab. */
function render() {
  const restore = keepFocus(screen)
  drawScreen()
  keepControls(screen, `screen-${tab}`)
  restore()
}

function drawScreen() {
  if (!state) {
    screen.replaceChildren()
    const start = document.createElement('section')
    start.className = 'quiet'
    start.setAttribute('aria-live', 'polite')
    const text = document.createElement('p')
    text.textContent = loading ? 'Loading' : (message || 'No connection. Try again.')
    start.append(text)
    if (!loading) {
      const retry = document.createElement('button')
      retry.className = 'primary'
      retry.textContent = 'Try again'
      retry.onclick = () => refresh()
      start.append(retry)
    }
    screen.append(start)
    return
  }
  document.querySelectorAll('#tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab)
    button.setAttribute('aria-selected', String(button.dataset.tab === tab))
  })
  screen.replaceChildren()
  calendarHost.hidden = tab !== 'calendar'
  document.querySelector('.phone').classList.toggle('calendar-tab', tab === 'calendar')
  if (tab === 'today') renderToday()
  if (tab === 'calendar') renderCalendar()
  if (tab === 'owed') renderOwed()
  if (tab === 'settings') renderSettings()
}

setReminderStopper(async (invoiceId) => {
  try {
    const answer = await post(`/api/invoices/${encodeURIComponent(invoiceId)}/stop-reminders`)
    setState(answer.state)
  } catch (error) {
    showError(error)
    throw error
  }
})

/** Shows notices and the current proposal. */
function renderToday() {
  const notices = [...(state.ws.notices || [])]
    .sort((first, second) => (second.n || second.at) - (first.n || first.at))
    .slice(0, 5)
  let section
  if (notices.length) {
    section = document.createElement('section')
    section.className = 'notices'
    section.setAttribute('aria-live', 'polite')
    notices.forEach((notice) => {
      const receiptId = notice.settlementId || notice.invoiceId
      const element = document.createElement(receiptId ? 'a' : 'div')
      element.className = 'notice'
      if (receiptId) {
        element.href = '#'
        element.onclick = (event) => {
          event.preventDefault()
          openInvoiceSheet(receiptId, state, request)
        }
      }
      element.textContent = notice.text
      section.append(element)
    })
    if (!proposal) screen.append(section)
  }
  if (message) {
    const quiet = document.createElement('div')
    quiet.className = 'quiet'
    quiet.setAttribute('aria-live', 'polite')
    quiet.textContent = message
    screen.append(quiet)
  }
  if (proposal) {
    const card = renderProposal(proposal, {
      state, money, esc, customer, post, submitText,
      openInvoice: (invoiceId) => openInvoiceSheet(invoiceId, state, request),
      onDone: (answer) => {
        if (!validState(answer?.state)) throw { message: 'Something went wrong. Try again.' }
        proposal = null
        message = null
        setState(answer.state)
        if (answer.invoiceId) openInvoiceSheet(answer.invoiceId, state, request)
        if (answer.settlement) openInvoiceSheet(answer.settlement.id, state, request)
      },
      // A change that keeps the card on screen, such as a rate change tapped on a draft.
      onUpdate: (next) => setState(next),
      onError: showError
    })
    card.tabIndex = -1
    screen.append(card)
    if (section) screen.append(section)
    if (focusedProposal !== proposal) {
      focusedProposal = proposal
      card.focus()
    }
  } else if (state.budget?.replay || !message) {
    focusedProposal = null
    const suggestions = document.createElement('section')
    suggestions.className = 'try-saying'
    const heading = document.createElement('h2')
    heading.textContent = 'Try saying'
    const lines = document.createElement('div')
    lines.className = 'try-saying-lines'
    demoLines.forEach((line) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = line
      button.onclick = () => {
        $('#say').value = line
        submitText(line)
      }
      lines.append(button)
    })
    suggestions.append(heading, lines)
    screen.append(suggestions)
  } else if (!notices.length && !message) {
    const quiet = document.createElement('div')
    quiet.className = 'quiet'
    quiet.textContent = 'Ready when you are.'
    screen.append(quiet)
  }
}

/** Bryntum Calendar when its files were deployed, else the plain grid; ?calendar=fallback or bryntum picks one. */
async function makeCalendar(options) {
  const wanted = new URLSearchParams(location.search).get('calendar')
  let failed = false
  let active
  let data
  let notice
  let attempt = 0
  const primary = async () => {
    const bryntum = await import(`./calendar.js?attempt=${++attempt}`)
    if (wanted !== 'bryntum' && !(await bryntum.bryntumAvailable())) return null
    return await bryntum.createCalendar(calendarHost, options)
  }
  if (wanted !== 'fallback') {
    try { active = await primary() } catch { failed = true; calendarHost.replaceChildren() }
  }
  const fallback = async () => {
    const { createCalendar } = await import('./fallback-calendar.js')
    active = createCalendar(calendarHost, options)
  }
  if (!active) await fallback()
  if (failed) {
    notice = document.createElement('div')
    notice.textContent = 'The full calendar could not load. Your jobs are shown below.'
    const retry = document.createElement('button')
    retry.textContent = 'Retry calendar'
    retry.onclick = async () => {
      retry.disabled = true
      active.destroy()
      calendarHost.replaceChildren()
      try {
        active = await primary()
        if (!active) throw new Error('Calendar unavailable')
        failed = false
        notice.remove()
      } catch {
        await fallback()
      } finally {
        retry.disabled = false
        if (data) view.render(data)
      }
    }
    notice.append(retry)
  }
  const view = {
    render(next) { data = next; active.render(next); if (failed) calendarHost.prepend(notice) },
    destroy() { active.destroy(); notice?.remove() }
  }
  return view
}

/** Draws the calendar, its legend, and pending offers. */
function renderCalendar() {
  const data = { ...state.ws, now: serverTime + Date.now() - clientTime, tz: state.ws.tz, reminders: state.reminders }
  if (calendar) calendar.render(data)
  else if (!calendarLoading) {
    calendarLoading = makeCalendar({
      onMove: async (jobId, start) => {
        try {
          const answer = await post('/api/schedule/move', { jobId, start })
          message = answer.text
          setState(answer.state)
        } catch (error) {
          showError(error)
        }
      }
    }).then((made) => {
      calendar = made
      if (tab === 'calendar') calendar.render({ ...state.ws, now: serverTime + Date.now() - clientTime, tz: state.ws.tz, reminders: state.reminders })
    }).catch(() => { calendarLoading = null; message = 'The calendar could not load. Open this tab to try again.' })
  }
  if (message) {
    const notice = document.createElement('div')
    notice.className = 'quiet'
    notice.textContent = message
    screen.append(notice)
  }
  const legend = document.createElement('div')
  legend.className = 'legend'
  for (const name of ['booked', 'sent', 'paid', 'held', 'late', 'released']) {
    const item = document.createElement('span')
    item.style.setProperty('--state', `var(--${name})`)
    item.textContent = name
    legend.append(item)
  }
  screen.append(legend)
  if (state.ws.settings.holdMinutes === 2) {
    state.ws.holds.filter((hold) => !hold.ended && hold.expiresAt > serverTime + Date.now() - clientTime).forEach((hold) => {
      const job = state.ws.jobs.find((item) => item.id === hold.jobId)
      const card = document.createElement('article')
      card.className = 'offer'
      const label = document.createElement('p')
      label.textContent = `Held slot for ${customer(job?.customerId)}`
      const button = document.createElement('button')
      button.dataset.keep = `expire-${hold.jobId}`
      button.textContent = 'Run out the hold now'
      button.onclick = async () => {
        button.disabled = true
        try {
          const answer = await post(`/api/holds/${encodeURIComponent(hold.jobId)}/expire`)
          setState(answer.state)
        } catch (error) {
          button.disabled = false
          showError(error)
        }
      }
      card.append(label, button)
      screen.append(card)
    })
  }
  Object.values(state.ws.offers || {}).filter((offer) => !offer.accepted).forEach((offer) => {
    const job = state.ws.jobs.find((item) => item.id === offer.jobId)
    const card = document.createElement('article')
    card.className = 'offer'
    const text = document.createElement('p')
    const date = new Date(Date.parse(offer.start) + state.ws.tz * 60000)
    const label = date.toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC'
    })
    text.textContent = `Slot freed: ${label} offered to ${customer(job?.customerId)}`
    const button = document.createElement('button')
    button.dataset.keep = `accept-${offer.id}`
    button.textContent = `Send deposit ${money(state.ws.settings.rateCard.deposit)}`
    button.onclick = async () => {
      button.disabled = true
      decline.disabled = true
      try {
        const answer = await post(`/api/offers/${encodeURIComponent(offer.id)}/accept`)
        setState(answer.state)
        if (answer.invoiceId) openInvoiceSheet(answer.invoiceId, state, request)
      } catch (error) {
        decline.disabled = false
        button.disabled = false
        showError(error)
      }
    }
    const reason = document.createElement('p')
    reason.className = 'reason'
    reason.textContent = offer.reason || ''
    const decline = document.createElement('button')
    decline.dataset.keep = `decline-${offer.id}`
    decline.textContent = 'Not now'
    decline.onclick = async () => {
      decline.disabled = true
      button.disabled = true
      try {
        const answer = await post(`/api/offers/${encodeURIComponent(offer.id)}/decline`)
        setState(answer.state)
      } catch (error) {
        decline.disabled = false
        button.disabled = false
        showError(error)
      }
    }
    card.append(text, reason, button, decline)
    screen.append(card)
  })
  renderWaiting()
}

/** Lists waiting jobs and keeps the add form through state polls. */
function renderWaiting() {
  const section = document.createElement('section')
  section.className = 'waiting-list'
  section.setAttribute('aria-label', 'Waiting list')
  section.innerHTML = '<h2>Waiting list</h2>'
  const names = { any: 'Any time', mornings: 'Mornings', afternoons: 'Afternoons' }
  for (const id of state.ws.waiting || []) {
    const job = state.ws.jobs.find((item) => item.id === id && item.state === 'waiting')
    if (!job) continue
    const row = document.createElement('div')
    row.className = 'waiting-row'
    row.dataset.waitingId = id
    const person = state.ws.customers.find((item) => item.id === job.customerId)
    const name = person?.given || person?.name.split(' ')[0] || 'Customer'
    const free = Array.isArray(job.free) ? job.free.map((day) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][day]).join(', ') : names[job.free || 'any']
    const text = document.createElement('span')
    text.textContent = `${name} ${job.summary} ${job.hours} h ${free}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.dataset.keep = `waiting-remove-${id}`
    remove.textContent = 'Remove'
    remove.onclick = async () => {
      remove.disabled = true
      try {
        const answer = await post(`/api/waiting/${encodeURIComponent(id)}/remove`)
        waitingError = ''
        setState(answer.state)
      } catch (error) {
        waitingError = error.message || 'Something went wrong. Try again.'
        render()
      }
    }
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = 'Edit'
    edit.dataset.keep = `waiting-edit-${id}`
    edit.disabled = busyKeys.has('waiting-add')
    edit.onclick = () => {
      waitingEditId = id
      waitingFields = { customerId: job.customerId, summary: job.summary, hours: String(job.hours), free: Array.isArray(job.free) ? JSON.stringify(job.free) : job.free || 'any' }
      waitingError = ''
      render()
    }
    row.append(text, edit, remove)
    section.append(row)
  }
  const form = document.createElement('form')
  if (waitingFields.free.startsWith('[')) names[waitingFields.free] = 'Selected weekdays'
  form.className = 'waiting-form'
  form.innerHTML = `<label>Customer <select name="customerId" aria-label="Customer" data-keep="waiting-customer" required>${state.ws.customers.map((person) => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('')}</select></label>
    <label>Summary <input name="summary" data-keep="waiting-summary" maxlength="80" required></label>
    <label>Hours <select name="hours" aria-label="Hours" data-keep="waiting-hours">${Array.from({ length: 16 }, (_, index) => (index + 1) / 2).map((hours) => `<option value="${hours}">${hours} h</option>`).join('')}</select></label>
    <label>When free <select name="free" aria-label="When free" data-keep="waiting-free">${Object.entries(names).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
    <button type="submit" data-keep="waiting-add">Add</button>`
  if (!state.ws.customers.some((person) => person.id === waitingFields.customerId)) waitingFields.customerId = state.ws.customers[0]?.id || ''
  for (const control of form.querySelectorAll('input, select')) {
    control.value = waitingFields[control.name]
    control.oninput = control.onchange = () => { waitingFields[control.name] = control.value }
  }
  const errorLine = document.createElement('p')
  errorLine.setAttribute('role', 'alert')
  errorLine.textContent = waitingError
  const add = form.querySelector('button')
  add.textContent = waitingEditId ? 'Save changes' : 'Add'
  add.disabled = busyKeys.has('waiting-add')
  if (waitingEditId) {
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel edit'
    cancel.disabled = busyKeys.has('waiting-add')
    cancel.onclick = () => { waitingEditId = null; waitingFields = { ...waitingFields, summary: '', free: 'any' }; render() }
    form.append(cancel)
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (busyKeys.has('waiting-add')) return
    busyKeys.add('waiting-add')
    add.disabled = true
    waitingError = ''
    try {
      const answer = await post(waitingEditId ? `/api/waiting/${encodeURIComponent(waitingEditId)}` : '/api/waiting', { ...waitingFields, hours: Number(waitingFields.hours), free: waitingFields.free.startsWith('[') ? JSON.parse(waitingFields.free) : waitingFields.free })
      waitingEditId = null
      waitingFields = { ...waitingFields, summary: '' }
      setState(answer.state)
    } catch (error) {
      waitingError = error.message || 'Something went wrong. Try again.'
      render()
    } finally {
      busyKeys.delete('waiting-add')
      const button = screen.querySelector('[data-keep="waiting-add"]')
      if (button) button.disabled = false
    }
  }
  section.append(form, errorLine)
  screen.append(section)
}

/** Lists unpaid invoices and lets the user ask for a summary. */
function renderOwed() {
  const lateDays = state.ws.settings.lateDays ?? 7
  const invoices = Object.values(state.ws.invoices || {}).filter((invoice) =>
    ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(invoice.status)
  ).map((invoice) => ({
    invoice,
    sentAt: Number(invoice.sentAt) || 0,
    days: Math.max(0, Math.floor((state.now - (invoice.sentAt || state.now)) / 86400000)),
    due: Number(invoice.due) || 0
  })).filter((item) => item.due > 0)
  const late = (item) => item.days > lateDays
  invoices.sort((first, second) => {
    if (late(first) !== late(second)) return late(first) ? -1 : 1
    return late(first) ? first.sentAt - second.sentAt : second.sentAt - first.sentAt
  })

  const summary = document.createElement('div')
  summary.className = 'owed-summary'
  if (invoices.length) {
    const label = document.createElement('div')
    label.className = 'meta'
    label.textContent = 'Owed to you'
    const amount = document.createElement('div')
    amount.className = 'money'
    amount.textContent = money(invoices.reduce((total, item) => total + item.due, 0))
    const count = document.createElement('div')
    count.className = 'meta'
    count.textContent = `on ${invoices.length} ${invoices.length === 1 ? 'invoice' : 'invoices'}`
    summary.append(label, amount, count)
  } else {
    summary.textContent = 'Nothing owed.'
  }
  screen.append(summary)

  if (invoices.length) {
    const list = document.createElement('section')
    list.className = 'owed-list'
    let group
    invoices.forEach(({ invoice, days, due: owedAmount }) => {
      const nextGroup = days > lateDays ? 'Late' : 'Waiting'
      if (group !== nextGroup) {
        const heading = document.createElement('h3')
        heading.className = 'owed-group'
        heading.textContent = nextGroup
        list.append(heading)
        group = nextGroup
      }
      const row = document.createElement('button')
      row.dataset.keep = `invoice-${invoice.id}`
      row.className = 'owed-row'
      const main = document.createElement('span')
      main.className = 'row-main'
      const name = document.createElement('strong')
      name.textContent = customer(invoice.customerId)
      const amount = document.createElement('span')
      amount.className = 'row-amount'
      amount.textContent = money(owedAmount)
      main.append(name, amount)
      const details = document.createElement('span')
      details.className = 'owed-details'
      if (invoice.shared) {
        const shared = document.createElement('small')
        shared.className = 'owed-shared'
        shared.textContent = 'shared demo invoice'
        details.append(shared)
      }
      const dueLabel = document.createElement('span')
      dueLabel.className = 'owed-due'
      dueLabel.append(document.createTextNode(days === 0 ? 'sent today' : days === 1 ? '1 day' : `${days} days`))
      if (days > lateDays) {
        const badge = document.createElement('small')
        badge.className = 'owed-late'
        badge.textContent = 'late'
        dueLabel.append(' ', badge)
      }
      details.append(dueLabel)
      row.append(main, details)
      if (invoice.reminders) {
        const reminders = document.createElement('div')
        reminders.className = 'meta'
        reminders.textContent = invoice.reminders === 1 ? '1 reminder sent' : `${invoice.reminders} reminders sent`
        row.append(reminders)
      }
      row.onclick = () => openInvoiceSheet(invoice.id, state, request)
      list.append(row)
    })
    screen.append(list)
    const where = document.createElement('p')
    where.className = 'meta owed-where'
    where.textContent = 'Payments go to your PayPal account.'
    screen.append(where)
  }
  const button = document.createElement('button')
  button.className = 'primary'
  button.classList.add('owed-action')
  button.textContent = 'What am I owed?'
  button.onclick = async () => {
    try {
      const answer = await post('/api/agent', { text: button.textContent })
      proposal = answer.proposal
      message = answer.message
      tab = 'today'
      setState(answer.state)
    } catch (error) {
      showError(error)
    }
  }
  screen.append(button)
}

/** Displays the rate card and workspace settings. */
function renderSettings() {
  const rate = state.ws.settings.rateCard
  const card = document.createElement('article')
  card.className = 'card'
  card.innerHTML = `<h2>Demo rate card</h2>
    <p class="rate-callout">Call out ${money(rate.callout)}</p>
    <p class="rate-labour">Labour ${money(rate.labourPerHour)} per hour</p>
    <p>Billing step ${esc(rate.billingStepMinutes)} minutes</p>
    <p>Tax ${esc(rate.taxPercent)}%</p>
    <p>Deposit ${money(rate.deposit)}</p>`
  // A rate the tradesperson said and tapped names where it came from.
  for (const [field, selector] of [['callout', '.rate-callout'], ['labourPerHour', '.rate-labour']]) {
    const learned = rate.learned?.[field]
    if (!learned) continue
    const source = document.createElement('span')
    source.className = 'source'
    source.textContent = `you said ${learned.said} on ${learned.on}`
    card.querySelector(selector).append(source)
  }
  screen.append(card)
  const row = document.createElement('div')
  row.className = 'settings-row'
  for (const [label, value] of [['Demo hold 2 minutes', 2], ['Normal hold 24 hours', 1440]]) {
    const button = document.createElement('button')
    button.dataset.keep = `hold-minutes-${value}`
    button.textContent = label
    button.setAttribute('aria-pressed', String(state.ws.settings.holdMinutes === value))
    button.onclick = async () => {
      try {
        setState((await post('/api/settings', { holdMinutes: value })).state)
      } catch (error) {
        showError(error)
      }
    }
    row.append(button)
  }
  screen.append(row)
  const fresh = document.createElement('button')
  fresh.className = 'primary'
  fresh.textContent = 'Start a fresh demo'
  fresh.onclick = async () => {
    try {
      proposal = null
      message = null
      setState(await post('/api/workspace', { tz: -new Date().getTimezoneOffset() }))
    } catch (error) {
      showError(error)
    }
  }
  screen.append(fresh)
}

/** Submits typed text to the agent. */
async function submitText(text) {
  if (!text.trim() || sendingText) return
  sendingText = true
  $('#sendText').disabled = true
  $('#say').value = ''
  try {
    const answer = await post('/api/agent', { text })
    if (!answer || !validState(answer.state) || !Object.hasOwn(answer, 'proposal')) throw { message: 'Something went wrong. Try again.' }
    if (answer.proposal && !validProposal(answer.proposal)) throw { message: 'Something went wrong. Try again.' }
    proposal = answer.proposal
    message = answer.message
    tab = 'today'
    setState(answer.state)
  } catch (error) {
    showError(error)
  } finally {
    sendingText = false
    $('#sendText').disabled = false
  }
}

function validState(value) {
  return Boolean(value?.ws && Array.isArray(value.ws.customers) && Array.isArray(value.ws.jobs) && value.ws.settings)
}

function validProposal(value) {
  if (!value || typeof value.kind !== 'string') return false
  if (value.kind === 'invoice') return typeof value.customer === 'string' && typeof value.summary === 'string' && Array.isArray(value.priced?.lines)
  if (value.kind === 'booking') return typeof value.customer === 'string' && typeof value.summary === 'string'
  if (value.kind === 'waiting') return typeof value.customerId === 'string' && typeof value.customer === 'string' && typeof value.summary === 'string' && typeof value.hours === 'number'
  if (value.kind === 'cash') return value.amount != null && typeof value.customer === 'string'
  if (value.kind === 'reminder') return typeof value.text === 'string' && typeof value.customer === 'string'
  if (value.kind === 'answer') return typeof value.text === 'string'
  if (value.kind === 'new_customer') return typeof value.name === 'string'
  if (value.kind === 'rate') return Array.isArray(value.rateChanges) && value.rateChanges.length > 0 && value.rateChanges.every((change) => change && typeof change === 'object' && typeof change.id === 'string' && typeof change.label === 'string' && change.from != null && change.value != null)
  return false
}

$('#sendText').onclick = () => submitText($('#say').value)
$('#say').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitText($('#say').value)
  }
})
document.querySelectorAll('#tabs button').forEach((button) => {
  button.onclick = () => {
    tab = button.dataset.tab
    render()
  }
})
$('#panelToggle').onclick = () => {
  $('#mobilePanel').hidden = false
}
$('#closePanel').onclick = () => {
  $('#mobilePanel').hidden = true
}
setupTalk({ request, submitText, showError })
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state) refresh()
})
refresh()
setInterval(() => {
  if (!document.hidden && state) refresh()
}, 3000)
