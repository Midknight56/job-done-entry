// Provides a movable week calendar when no external calendar is configured.

import { openingTime } from './week.js'
import { jobWords, jobDetails } from './job-words.js'

/** Creates a calendar renderer with a callback for moved jobs. */
export function createCalendar(element, { onMove } = {}) {
  let current = {}
  let weekShift = 0
  let selectedDay = null
  let draggedJob
  let pointerOrigin
  let moved = false
  let focusedJobId = null
  let preview = null
  const details = jobDetails(element)

  /** Converts an instant to workspace local date parts. */
  function localParts(milliseconds, timezone) {
    const date = new Date(milliseconds + timezone * 60000)
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes()
    }
  }

  /** Converts a local calendar date and hour into an ISO instant. */
  function localIso(milliseconds, timezone, hour) {
    const date = new Date(milliseconds)
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour) - timezone * 60000).toISOString()
  }

  /** Renders the current five day work week. */
  function render(data) {
    if (element.contains(document.activeElement) && document.activeElement.dataset?.jobId) {
      focusedJobId = document.activeElement.dataset.jobId
    }
    const previousBlocks = new Map(
      [...element.querySelectorAll('.job-block')].map((block) => [
        block.dataset.jobId,
        { bounds: block.getBoundingClientRect(), color: getComputedStyle(block).backgroundColor }
      ])
    )
    current = data
    details.render(data)
    const {
      jobs = [], customers = [],
      now = Date.now(), tz = 0, workHours = [8, 17]
    } = data
    const localNow = new Date(openingTime(now, tz) + tz * 60000)
    const weekday = (localNow.getUTCDay() + 6) % 7
    const monday = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() - weekday + weekShift * 7
    )
    // One day at a time when the calendar is narrow (a phone, or the phone frame on a wide screen).
    const mobile = element.clientWidth < 520
    // The day picker starts on the opening weekday, or Monday on a weekend.
    if (selectedDay === null) selectedDay = weekday < 5 ? weekday : 0
    const [firstHour, lastHour] = workHours
    const hourHeight = 48
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    const customerById = Object.fromEntries(customers.map((person) => [person.id, person]))
    element.replaceChildren()
    const shell = document.createElement('div')
    shell.className = 'calendar-shell'
    const navigation = document.createElement('div')
    navigation.className = 'calendar-head'
    const previous = document.createElement('button')
    previous.textContent = 'Prev'
    previous.setAttribute('aria-label', 'Previous week')
    previous.onclick = () => {
      weekShift -= 1
      render(current)
    }
    const range = document.createElement('strong')
    const firstDate = new Date(monday).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const lastDate = new Date(monday + 4 * 86400000).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
    range.textContent = `${firstDate} to ${lastDate}`
    const next = document.createElement('button')
    next.textContent = 'Next'
    next.setAttribute('aria-label', 'Next week')
    next.onclick = () => {
      weekShift += 1
      render(current)
    }
    navigation.append(previous, range, next)
    shell.append(navigation)
    if (mobile) {
      const picker = document.createElement('div')
      picker.className = 'day-pick'
      dayNames.forEach((name, index) => {
        const button = document.createElement('button')
        button.textContent = name
        button.setAttribute('aria-pressed', String(selectedDay === index))
        button.onclick = () => {
          selectedDay = index
          render(current)
        }
        picker.append(button)
      })
      shell.append(picker)
    }
    const grid = document.createElement('div')
    grid.className = `cal-grid${mobile ? ' mobile' : ''}`
    grid.style.setProperty('--hours', lastHour - firstHour)
    grid.addEventListener('pointerup', (event) => {
      if (!draggedJob) return
      const jobId = draggedJob
      draggedJob = null
      moved = Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 6
      if (!moved) return
      const bounds = grid.getBoundingClientRect()
      const gutter = mobile ? 44 : 38
      const dayWidth = (bounds.width - gutter) / (mobile ? 1 : 5)
      const dayIndex = mobile
        ? selectedDay
        : Math.max(0, Math.min(4, Math.floor((event.clientX - bounds.left - gutter) / dayWidth)))
      const hourIndex = Math.floor((event.clientY - bounds.top - 28) / 48)
      const targetHour = Math.max(firstHour, Math.min(lastHour - 1, firstHour + hourIndex))
      onMove?.(jobId, localIso(monday + dayIndex * 86400000, tz, targetHour))
    })
    const timeColumn = document.createElement('div')
    timeColumn.className = 'cal-time-column'
    const timeHeading = document.createElement('div')
    timeHeading.className = 'cal-day'
    timeColumn.append(timeHeading)
    for (let hour = firstHour; hour < lastHour; hour += 1) {
      const label = document.createElement('div')
      label.className = 'cal-hour'
      label.textContent = `${String(hour).padStart(2, '0')}:00`
      timeColumn.append(label)
    }
    grid.append(timeColumn)
    const columns = []
    dayNames.forEach((name, index) => {
      const column = document.createElement('div')
      column.className = `cal-column${mobile && index !== selectedDay ? ' hidden-day' : ''}`
      column.dataset.day = index
      const heading = document.createElement('div')
      heading.className = 'cal-day'
      heading.textContent = `${name} ${new Date(monday + index * 86400000).getUTCDate()}`
      column.append(heading)
      for (let hour = firstHour; hour < lastHour; hour += 1) {
        const track = document.createElement('div')
        track.className = 'cal-track'
        track.dataset.hour = hour
        column.append(track)
      }
      columns.push(column)
      grid.append(column)
    })
    jobs.filter((job) => job.start && job.state !== 'draft' && job.state !== 'waiting').forEach((job) => {
      const jobStart = preview?.jobId === job.id ? preview.start : job.start
      const startMs = Date.parse(jobStart)
      const parts = localParts(startMs, tz)
      const dateMs = Date.UTC(parts.year, parts.month, parts.day)
      const dayIndex = Math.floor((dateMs - monday) / 86400000)
      if (dayIndex < 0 || dayIndex > 4) return
      const words = jobWords(job, data)
      const shownState = words.state
      const block = document.createElement('div')
      block.className = 'job-block'
      block.dataset.jobId = job.id
      block.dataset.state = shownState
      block.addEventListener('click', () => {
        if (!moved) details.toggle(job.id, current)
        moved = false
      })
      const firstName = (customerById[job.customerId]?.name || '').split(' ')[0]
      const movable = shownState !== 'paid' && shownState !== 'released'
      if (movable) {
        block.tabIndex = 0
        const date = new Date(dateMs)
        const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
        block.setAttribute('aria-label', `${job.summary || 'Job'} for ${firstName}, ${dayNames[dayIndex]} ${parts.day} ${date.toLocaleDateString([], { month: 'short', timeZone: 'UTC' })} ${time}. Arrow keys move it, Enter saves.`)
        block.addEventListener('focus', () => {
          focusedJobId = job.id
        })
        block.addEventListener('keydown', (event) => {
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Escape') {
            if (preview?.jobId === job.id) {
              preview = null
              render(current)
            }
            return
          }
          if (event.key === 'Enter') {
            if (preview?.jobId === job.id) {
              const newStart = preview.start
              preview = null
              onMove?.(job.id, newStart)
            }
            return
          }
          if (!preview || preview.jobId !== job.id) preview = { jobId: job.id, start: job.start }
          const move = localParts(Date.parse(preview.start), tz)
          const previewDate = Date.UTC(move.year, move.month, move.day)
          let previewDay = Math.floor((previewDate - monday) / 86400000)
          if (event.key === 'ArrowUp') move.hour = Math.max(firstHour, move.hour - 1)
          if (event.key === 'ArrowDown') move.hour = Math.min(lastHour - 1, move.hour + 1)
          if (event.key === 'ArrowLeft') previewDay = Math.max(0, previewDay - 1)
          if (event.key === 'ArrowRight') previewDay = Math.min(4, previewDay + 1)
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            if (mobile) selectedDay = previewDay
          }
          const dayDate = new Date(monday + previewDay * 86400000)
          preview.start = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), move.hour, move.minute) - tz * 60000).toISOString()
          render(current)
        })
      }
      if (preview?.jobId === job.id) block.classList.add('keyboard-preview')
      block.style.setProperty('--state', `var(--${shownState})`)
      block.style.top = `${28 + (parts.hour - firstHour + parts.minute / 60) * hourHeight}px`
      block.style.height = `${Math.max(30, (Date.parse(job.end) - startMs) / 3600000 * hourHeight - 2)}px`
      // Plain text only: a summary can come from the model, which reads what a visitor typed.
      const who = document.createElement('strong')
      who.textContent = firstName
      block.replaceChildren(who, document.createElement('br'), document.createTextNode(job.summary || ''))
      const countdown = document.createElement('small')
      countdown.textContent = words.line
      block.append(countdown)
      if (movable) block.addEventListener('pointerdown', (event) => {
        draggedJob = job.id
        pointerOrigin = { x: event.clientX, y: event.clientY }
        moved = false
        block.setPointerCapture(event.pointerId)
      })
      columns[dayIndex].append(block)
      const previous = previousBlocks.get(job.id)
      if (previous) {
        const bounds = block.getBoundingClientRect()
        const moveX = previous.bounds.left - bounds.left
        const moveY = previous.bounds.top - bounds.top
        block.style.transition = 'none'
        block.style.transform = 'translate(' + moveX + 'px, ' + moveY + 'px)'
        block.style.backgroundColor = previous.color
        requestAnimationFrame(() => {
          block.style.transition = 'transform .3s, background-color .3s'
          block.style.transform = ''
          block.style.backgroundColor = ''
        })
      }
    })
    shell.append(grid)
    element.append(shell)
    if (focusedJobId) element.querySelector(`[data-job-id="${focusedJobId}"]`)?.focus()
  }
  return { render, destroy: () => { details.destroy(); element.replaceChildren() } }
}
