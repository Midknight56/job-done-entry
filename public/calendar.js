// The tradesperson's week on Bryntum Calendar. This is the only file that touches Bryntum. It has the same interface
// as fallback-calendar.js: createCalendar(element, { onMove }) returns { render(data), destroy() }. The server owns
// the schedule; render() applies its state to the Calendar's own event store record by record, so a move the agent
// made (a slot freed, a waiting job moved in) animates on screen instead of redrawing the whole week.

import { plannedReminders } from './reminder-plan.js'
import { openingTime } from './week.js'
import { jobWords, jobDetails } from './job-words.js'

const VENDOR = '/vendor/bryntum'
let stylesPromise

/** Loads Bryntum's styles once; the Font Awesome files come with the package so nothing loads from another host. */
function loadStyles() {
  if (!stylesPromise) {
    const links = ['fontawesome/css/fontawesome.css', 'fontawesome/css/solid.css', 'calendar.css', 'svalbard-light.css', '/calendar.css'].map((href) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href.startsWith('/') ? href : `${VENDOR}/${href}`
      link.dataset.bryntum = ''
      const loaded = new Promise((resolve) => {
        link.addEventListener('load', resolve, { once: true })
        link.addEventListener('error', resolve, { once: true })
      })
      document.head.append(link)
      return loaded
    })
    stylesPromise = Promise.all(links)
  }
  return stylesPromise
}

/** True when the Bryntum files were copied into public/vendor at build time. */
export async function bryntumAvailable() {
  try {
    const res = await fetch(`${VENDOR}/VERSION`, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/** One server job as a Calendar event. */
function toEvent(job, data) {
  const customer = data.customers.find((c) => c.id === job.customerId)
  const words = jobWords(job, data)
  const state = words.state
  return {
    id: job.id,
    name: `${customer ? customer.name.split(' ')[0] : ''} ${job.summary}`.trim(),
    startDate: new Date(job.start),
    endDate: new Date(job.end),
    cls: `jd-state-${state}`,
    draggable: state !== 'released' && state !== 'paid',
    resizable: false,
    jobState: state,
    customerName: customer ? customer.name.split(' ')[0] : '',
    summary: job.summary,
    holdText: words.line,
  }
}

/** One reminder PayPal will send by itself, as a faint event that cannot be moved. */
function toReminderEvent(reminder, data) {
  const customer = data.customers.find((c) => c.id === reminder.customerId)
  const first = customer ? customer.name.split(' ')[0] : ''
  return {
    id: reminder.id,
    name: first ? `${first}: PayPal reminder` : 'PayPal reminder',
    startDate: new Date(reminder.start),
    endDate: new Date(reminder.end),
    allDay: true,
    cls: 'jd-reminder',
    draggable: false,
    resizable: false,
    jobState: 'reminder',
    customerName: first,
    summary: 'PayPal reminder',
    holdText: '',
    reminderOf: reminder.invoiceId,
  }
}

/**
 * @param {HTMLElement} element
 * @param {{ onMove: (jobId: string, startIso: string) => Promise<void> }} options
 */
export async function createCalendar(element, { onMove }) {
  const styles = loadStyles()
  const { Calendar } = await import(`${VENDOR}/calendar.module.js?attempt=${Date.now()}`)
  // The top bar stacks in a column for good if the Calendar is built before its styles are in.
  await styles
  let first = true
  let current
  const details = jobDetails(element)
  let pendingTap
  let tapTimer
  const tap = (id) => {
    pendingTap = id
    if (tapTimer) return
    tapTimer = setTimeout(() => {
      tapTimer = null
      if (current) details.toggle(pendingTap, current)
    }, 0)
  }
  let calendar
  try {
  calendar = new Calendar({
    appendTo: element,
    mode: !document.documentElement.classList.contains('video') && (element.clientWidth ? element.clientWidth < 600 : matchMedia('(max-width: 600px)').matches) ? 'day' : 'week',
    date: new Date(openingTime(Date.now(), -new Date().getTimezoneOffset())),
    sidebar: false,
    tbar: { items: { modeSelector: { responsive: null, minified: false } } },
    weekStartDay: 1,
    hideNonWorkingDays: true,
    nonWorkingDays: { 0: true, 6: true },
    autoCreate: false,
    features: {
      eventEdit: false,
      eventMenu: false,
      scheduleMenu: false,
      eventTooltip: false,
      drag: { creatable: false },
    },
    modeDefaults: {
      // Each event's body carries the job id and money state, the same attributes the fallback grid uses.
      eventRenderer({ eventRecord }) {
        const children = [
          { tag: 'strong', text: eventRecord.get('customerName') },
          { tag: 'span', class: 'jd-summary', text: eventRecord.get('summary') || '' },
        ]
        if (eventRecord.get('holdText')) children.push({ tag: 'small', class: 'jd-hold', text: eventRecord.get('holdText') })
        if (eventRecord.get('reminderOf')) return { tag: 'span', dataset: { reminderOf: eventRecord.get('reminderOf'), state: 'reminder' }, text: eventRecord.name }
        return { tag: 'span', dataset: { jobId: String(eventRecord.id), state: eventRecord.get('jobState') }, children }
      },
    },
    modes: {
      day: { dayStartTime: 7, dayEndTime: 18, hourHeight: 72 },
      week: { dayStartTime: 7, dayEndTime: 18 },
      month: false,
      year: false,
      agenda: true,
    },
    listeners: {
      activeItemChange({ source, activeItem }) {
        const unit = activeItem.stepUnit || 'day'
        if (source.widgetMap?.prevButton) source.widgetMap.prevButton.ariaLabel = `Previous ${unit}`
        if (source.widgetMap?.nextButton) source.widgetMap.nextButton.ariaLabel = `Next ${unit}`
      },
      eventClick({ eventRecord }) {
        if (!eventRecord.get('reminderOf') && current) {
          tap(String(eventRecord.id))
        }
      },
      // The drop is only a request: the server checks the slot and the next render shows what it decided.
      dragMoveEnd({ eventRecord }) {
        if (eventRecord.get('reminderOf')) return
        onMove(String(eventRecord.id), eventRecord.startDate.toISOString())
      },
    },
  })
  } catch (error) { details.destroy(); element.replaceChildren(); throw error }
  // Selected events can consume the calendar's next eventClick. Keep a second tap available.
  const onClick = (event) => {
    const block = event.target.closest('.b-cal-event-wrap')
    const id = block?.querySelector('[data-job-id]')?.dataset.jobId
    if (id) tap(id)
  }
  element.addEventListener('click', onClick, true)

  /** Applies the server's schedule to the event store, one record at a time. */
  function render(data) {
    current = data
    details.render(data)
    const events = data.jobs.filter((job) => job.start && job.state !== 'waiting' && job.state !== 'draft').map((job) => toEvent(job, data))
    // The reminders PayPal will send for each open invoice; they go when it is paid or they are stopped.
    for (const reminder of plannedReminders(data)) events.push(toReminderEvent(reminder, data))
    const store = calendar.eventStore
    const wanted = new Set(events.map((e) => e.id))
    store.remove(store.records.filter((record) => !wanted.has(record.id)))
    for (const event of events) {
      const record = store.getById(event.id)
      if (!record) store.add(event)
      else if (record.startDate.getTime() !== event.startDate.getTime() || record.endDate.getTime() !== event.endDate.getTime() || record.get('jobState') !== event.jobState || record.name !== event.name || record.get('holdText') !== event.holdText) {
        record.set(event)
      }
    }
    if (first && data.now) {
      calendar.date = new Date(openingTime(data.now, data.tz))
      first = false
    }
  }

  return {
    render,
    destroy: () => { clearTimeout(tapTimer); element.removeEventListener('click', onClick, true); current = null; details.destroy(); calendar.destroy() },
  }
}
