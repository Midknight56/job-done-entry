// Builds proposal cards and sends the action chosen for each proposal.
const statusWord = (status) => ({ SENT: 'Waiting', UNPAID: 'Waiting', PARTIALLY_PAID: 'Part paid', PAID: 'Paid', MARKED_AS_PAID: 'Paid' })[status] || 'Open'

/** Creates the visible card for one proposal. */
export function renderProposal(proposal, helpers) {
  const { state, money, esc, customer, post, onDone, onError } = helpers
  const card = document.createElement('article')
  card.className = 'card'
  let action
  if (proposal.kind === 'invoice') {
    const priced = proposal.priced
    const covered = Number(priced.total) === 0 && Number(priced.depositCredit) > 0
    const deposit = state.ws?.settings?.rateCard?.deposit ?? '50.00'
    // The ticks live on the proposal: the page redraws this card on every state update.
    proposal.choices ??= { tip: true, part: false }
    const rows = priced.lines.map((line) => `<tr>
      <td>${esc(line.name)}<span class="source">${esc(line.source || 'rate card')}</span></td>
      <td>${esc(line.quantity)} x ${money(line.unitAmount)}<br>${money(line.amount)}</td>
    </tr>`).join('')
    card.innerHTML = `<span class="pill card-status">Draft</span>
      <h2>${esc(proposal.customer)}</h2>
      <section class="step step-job"><h3>1 Job</h3>
      <p>${esc(proposal.summary)}</p>
      <table class="line-table"><tbody>${rows}</tbody></table>
      <div class="totals"><span>Items</span><span>${money(priced.itemTotal)}</span></div>
      <div class="totals"><span>Tax ${esc(priced.taxPercent)}%</span><span>${money(priced.tax)}</span></div>
      ${priced.depositCredit ? `<div class="totals"><span>Job price</span><span>${money(priced.jobTotal)}</span></div><div class="totals"><span>Paid deposit</span><span>${money(priced.depositTotal || priced.depositCredit)}</span></div><div class="totals"><span>Applied credit</span><span>${money(priced.depositCredit)}</span></div>${Number(priced.depositRetained) < Number(priced.depositTotal) ? `<div class="totals"><span>Deposit retained</span><span>${money(priced.depositRetained)}</span></div>` : ''}${Number(priced.depositSurplus) > 0 ? `<div class="totals"><span>Surplus to resolve</span><span>${money(priced.depositSurplus)}</span></div><p>Agree how to return or use the surplus.</p>` : ''}` : ''}
      <div class="totals total"><span>${priced.depositCredit ? 'Remaining balance' : 'Total'}</span><span>${money(priced.total)}</span></div>
      </section>
      <section class="step step-visit"><h3>2 Visit</h3></section>
      <section class="step step-pay"><h3>3 Payment</h3>
      ${covered ? '<label><input type="checkbox" name="completeConfirmed"> I confirm this job is complete.</label>' : ''}
      <button class="primary">${covered ? 'Complete job' : `Send ${money(priced.total)}`}</button>
      </section>`
    const visitStep = card.querySelector('.step-visit')
    const person = state.ws.customers?.find((c) => c.id === proposal.customerId)
    const localTime = (value, style) => new Date(Date.parse(value) + state.ws.tz * 60000).toLocaleString([], { timeZone: 'UTC', ...style })
    const length = (start, end) => {
      const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000)
      const h = Math.floor(minutes / 60), m = minutes % 60
      return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min'
    }
    // Customer, address, start, end and length of a visit, in the calendar time zone.
    const visitLine = (visit) => `${person ? `${person.name}${person.address ? `, ${person.address}` : ''}. ` : ''}${localTime(visit.start, { dateStyle: 'medium', timeStyle: 'short' })} to ${localTime(visit.end, { timeStyle: 'short' })}, ${length(visit.start, visit.end)}`
    const choice = (name, text) => {
      const label = document.createElement('label')
      label.className = 'pay-choice'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = name
      input.checked = proposal.choices[name] === true
      input.onchange = () => { proposal.choices[name] = input.checked }
      label.append(input, ` ${text}`)
      return label
    }
    const send = card.querySelector('.primary')
    send.disabled = Boolean(proposal.needsVisit) || (covered ? !proposal.completeConfirmed : Number(priced.total) <= 0)
    if (covered) {
      const confirmation = card.querySelector('[name="completeConfirmed"]')
      confirmation.checked = proposal.completeConfirmed === true
      confirmation.onchange = () => {
        proposal.completeConfirmed = confirmation.checked
        send.disabled = Boolean(proposal.needsVisit) || !confirmation.checked
      }
    }
    if (proposal.needsVisit) {
      const visits = state.ws.jobs.filter((job) => job.customerId === proposal.customerId && ['booked', 'completed'].includes(job.state))
      if (!proposal.visitFields) {
        const distance = (job) => Math.abs(Date.parse(job.start) - state.now)
        const nearest = visits.filter((job) => job.state === 'booked' && distance(job) <= 86400000)
          .sort((a, b) => distance(a) - distance(b))[0]
        proposal.visitFields = { jobId: nearest?.id || '', start: '', end: '' }
        if (!nearest) {
          const hours = priced.lines.filter((line) => line.kind === 'labour')
            .reduce((sum, line) => sum + Number(line.quantity), 0) || 1
          const end = Math.floor((state.now + state.ws.tz * 60000) / 300000) * 300000
          const localInput = (time) => new Date(time).toISOString().slice(0, 16)
          proposal.visitFields.start = localInput(end - hours * 3600000)
          proposal.visitFields.end = localInput(end)
        }
      }
      const form = document.createElement('form')
      form.className = 'visit-form'
      const localLabel = (value) => new Date(Date.parse(value) + state.ws.tz * 60000).toLocaleString([], { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })
      form.innerHTML = `<p>Choose the visit for this invoice. Or enter a completed visit.</p>
        <label>Visit <select name="jobId"><option value="">New completed visit</option>${visits.map((job) => `<option value="${esc(job.id)}">${esc(job.summary)}. ${esc(localLabel(job.start))}</option>`).join('')}</select></label>
        <p class="visit-summary"></p>
        <div class="new-visit">
        <label>Start <input type="datetime-local" name="start"></label>
        <label>End <input type="datetime-local" name="end"></label>
        <p>Times use the calendar time zone.</p></div><button type="submit">Confirm visit</button>`
      // An existing visit shows its summary; only a new completed visit asks for times.
      const showChoice = () => {
        const chosen = visits.find((job) => job.id === proposal.visitFields.jobId)
        const summary = form.querySelector('.visit-summary')
        summary.textContent = chosen ? visitLine(chosen) : ''
        summary.hidden = !chosen
        form.querySelector('.new-visit').hidden = Boolean(chosen)
      }
      for (const control of form.querySelectorAll('input, select')) {
        control.value = proposal.visitFields[control.name]
        control.onchange = control.oninput = () => { proposal.visitFields[control.name] = control.value; if (control.name === 'jobId') showChoice() }
      }
      showChoice()
      form.onsubmit = async (event) => {
        event.preventDefault()
        const button = form.querySelector('button')
        if (proposal.confirmingVisit) return
        proposal.confirmingVisit = true
        button.disabled = true
        try {
          const fields = proposal.visitFields
          const utc = (value) => {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return ''
            return new Date(Date.parse(value + ':00Z') - state.ws.tz * 60000).toISOString()
          }
          const answer = await post(`/api/drafts/${encodeURIComponent(proposal.draftId)}/visit`, fields.jobId ? { jobId: fields.jobId } : { start: utc(fields.start), end: utc(fields.end) })
          proposal.jobId = answer.draft.jobId
          proposal.priced = answer.draft.priced
          proposal.needsVisit = false
          helpers.onUpdate(answer.state)
        } catch (error) { onError(error) } finally { proposal.confirmingVisit = false; button.disabled = false }
      }
      form.querySelector('button').disabled = Boolean(proposal.confirmingVisit)
      visitStep.append(form)
      const why = document.createElement('p')
      why.className = 'send-why'
      why.textContent = 'Confirm the visit to send.'
      send.before(why)
    } else {
      const visit = proposal.jobId ? state.ws.jobs.find((job) => job.id === proposal.jobId) : undefined
      if (visit) {
        const label = document.createElement('p')
        label.className = 'visit-confirmed'
        label.textContent = `Visit confirmed. ${visitLine(visit)}`
        visitStep.append(label)
      } else {
        // No visit to show: the payment step becomes step 2.
        visitStep.remove()
        card.querySelector('.step-pay h3').textContent = '2 Payment'
      }
    }
    // Above the lines, so the sticky Send button never covers it.
    for (const box of rateBoxes(proposal, helpers)) card.querySelector('.line-table').before(box)
    const options = document.createElement('div')
    options.className = 'pay-options'
    if (!covered) options.append(choice('tip', 'Allow a tip'))
    if (Number(priced.total) > Number(deposit)) options.append(choice('part', `Allow part now, at least ${money(deposit)}`))
    send.before(options)
    // The reason Send is waiting sits right above Send.
    const why = card.querySelector('.send-why')
    if (why) send.before(why)
    action = covered
      ? () => post(`/api/drafts/${encodeURIComponent(proposal.draftId)}/complete`, { confirmed: proposal.completeConfirmed === true })
      : () => post(`/api/drafts/${encodeURIComponent(proposal.draftId)}/send`, { tip: proposal.choices.tip, part: proposal.choices.part })
  } else if (proposal.kind === 'booking') {
    const hold = proposal.holdMinutes === 1440 ? '24 hours' : `${proposal.holdMinutes || 2} minutes`
    card.innerHTML = `<span class="pill card-status">Draft</span>
      <h2>${esc(proposal.customer)}</h2>
      <p>${esc(proposal.summary)}</p>
      <div class="totals"><span>When</span><span>${esc(proposal.slot?.label)}</span></div>
      <div class="totals"><span>Held for</span><span>${esc(hold)}</span></div>
      <div class="totals total"><span>Deposit</span><span>${money(proposal.deposit)}</span></div>
      <button class="primary">Send deposit ${money(proposal.deposit)}</button>`
    action = () => post(`/api/drafts/${encodeURIComponent(proposal.draftId)}/send`)
  } else if (proposal.kind === 'waiting') {
    const free = Array.isArray(proposal.free) ? proposal.free.map((day) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][day]).join(', ') : ({ any: 'Any time', mornings: 'Mornings', afternoons: 'Afternoons' })[proposal.free || 'any']
    card.innerHTML = `<h2>Add to waiting list</h2>
      <p>${esc(proposal.customer)} ${esc(proposal.summary)} ${esc(proposal.hours)} h ${esc(free)}</p>
      <button class="primary" data-keep="waiting-proposal-add">Add to waiting list</button>`
    action = () => post('/api/waiting', { customerId: proposal.customerId, summary: proposal.summary, hours: proposal.hours, free: proposal.free })
  } else if (proposal.kind === 'cash') {
    card.innerHTML = `<h2>Record ${money(proposal.amount)} cash from ${esc(proposal.customer)}</h2>
      <button class="primary">Record cash</button>`
    action = () => post(
      `/api/invoices/${encodeURIComponent(proposal.invoiceId)}/cash`,
      { amount: String(proposal.amount) }
    )
  } else if (proposal.kind === 'reminder') {
    proposal.edited ??= proposal.text
    card.innerHTML = `<h2>${esc(proposal.customer)}</h2>
      <p>PayPal sends its standard reminder.</p>
      <label class="remind-label">Your own message, to copy into a text or email
        <textarea class="remind-text" aria-label="Your own message, to copy into a text or email" rows="4"></textarea>
      </label>
      <div class="remind-actions"><button class="primary">Send PayPal reminder</button><button type="button" class="copy-message">Copy message</button></div>`
    const due = state.ws.invoices?.[proposal.invoiceId]?.due
    if (due != null) {
      const owed = document.createElement('div')
      owed.className = 'totals total'
      owed.innerHTML = `<span>Owed</span><span>${money(due)}</span>`
      card.querySelector('h2').after(owed)
    }
    const text = card.querySelector('.remind-text')
    text.value = proposal.edited
    text.oninput = () => { proposal.edited = text.value }
    const copy = card.querySelector('.copy-message')
    copy.onclick = async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(text.value)
        copy.textContent = 'Copied'
        setTimeout(() => { copy.textContent = 'Copy message' }, 2000)
      } catch {
        text.select()
        copy.textContent = 'Select the text and copy it'
      }
    }
    action = () => post(
      `/api/invoices/${encodeURIComponent(proposal.invoiceId)}/remind`,
      {}
    )
  } else if (proposal.kind === 'answer') {
    card.innerHTML = `<h2>${esc(proposal.text)}</h2>`
    for (const invoiceId of proposal.invoiceIds || []) {
      const invoice = state.ws.invoices[invoiceId]
      if (!invoice) continue
      const row = document.createElement('button')
      row.dataset.keep = `citation-${invoiceId}`
      row.className = 'citation'
      row.innerHTML = `<span class="row-main"><strong>${esc(customer(invoice.customerId))}</strong><span class="row-amount">${money(invoice.due)}</span></span>
        <span class="meta">${esc(statusWord(invoice.status))}</span>`
      row.onclick = () => helpers.openInvoice(invoiceId)
      card.append(row)
    }
  } else if (proposal.kind === 'new_customer') {
    proposal.fields ??= { name: proposal.name, address: '', email: '' }
    card.innerHTML = `<h2>New customer: ${esc(proposal.name)}</h2>
      <form class="customer-form">
        <label>Name <input name="name" maxlength="60" required></label>
        <label>Address <input name="address" maxlength="80"></label>
        <label>Email <input name="email" placeholder="name@example.com" required aria-describedby="customer-email-help"></label>
        <p class="meta" id="customer-email-help">Demo invoices go to example.com addresses only.</p>
        <p role="alert"></p>
        <button class="primary" type="submit">Save customer</button>
      </form>`
    const form = card.querySelector('form')
    const save = form.querySelector('button')
    const errorLine = form.querySelector('[role="alert"]')
    for (const input of form.querySelectorAll('input')) {
      input.value = proposal.fields[input.name]
      input.oninput = () => { proposal.fields[input.name] = input.value }
    }
    errorLine.textContent = proposal.error || ''
    save.disabled = Boolean(proposal.saving)
    form.onsubmit = async (event) => {
      event.preventDefault()
      if (proposal.saving) return
      proposal.saving = true
      save.disabled = true
      proposal.error = ''
      errorLine.textContent = ''
      try {
        const answer = await post('/api/customers', proposal.fields)
        helpers.onUpdate(answer.state)
        await helpers.submitText(proposal.text)
      } catch (error) {
        proposal.error = error.message || 'Something went wrong. Try again.'
        errorLine.textContent = proposal.error
      } finally {
        proposal.saving = false
        save.disabled = false
      }
    }
  } else if (proposal.kind === 'rate') {
    card.innerHTML = '<h2>Your rate card</h2>'
  }
  if (proposal.kind !== 'invoice') card.append(...rateBoxes(proposal, helpers))
  if (proposal.reason) {
    const title = card.querySelector('h2')
    if (title) {
      const reason = document.createElement('p')
      reason.className = 'reason'
      reason.textContent = proposal.reason
      title.after(reason)
    }
  }
  const button = card.querySelector('.primary')
  if (button && action) {
    button.onclick = async () => {
      button.disabled = true
      try {
        onDone(await action())
      } catch (error) {
        button.disabled = false
        onError(error)
      }
    }
  }
  // The note this card came from can go back in the box to be fixed. The tap sends nothing.
  if (proposal.note && helpers.editNote) {
    const row = document.createElement('div')
    row.className = 'edit-note-row'
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'edit-note'
    edit.textContent = 'Edit job note'
    edit.onclick = () => helpers.editNote(proposal.note)
    row.append(edit)
    card.append(row)
  }
  const identity = proposal.draftId || proposal.invoiceId || proposal.kind
  card.querySelectorAll('button, input, textarea').forEach((control, index) => {
    const role = control.classList.contains('primary') ? 'action' : index
    control.dataset.keep ||= `${proposal.kind}-${identity}-${control.name || control.getAttribute('aria-label') || role}`
  })
  return card
}

/**
 * A one tap change for each new rate said ("call out is 60 now"). The tap changes the card and, on an invoice card,
 * prices the draft again. Whether it was tapped lives on the proposal: the page redraws this card on every update.
 */
function rateBoxes(proposal, helpers) {
  const { money, post, onError } = helpers
  return (proposal.rateChanges || []).map((change) => {
    const box = document.createElement('div')
    box.className = 'rate-change'
    const text = document.createElement('p')
    box.append(text)
    if (change.accepted) {
      text.textContent = `${change.label} is now ${money(change.value)}`
      return box
    }
    text.textContent = `${change.label} on your card: ${money(change.from)}`
    const button = document.createElement('button')
    button.className = 'rate-update'
    button.dataset.keep = `rate-${change.id}`
    button.textContent = `Change to ${money(change.value)}`
    button.onclick = async () => {
      button.disabled = true
      try {
        const answer = await post(`/api/rates/${encodeURIComponent(change.id)}/accept`)
        change.accepted = true
        if (answer.priced && answer.draftId === proposal.draftId) proposal.priced = answer.priced
        helpers.onUpdate(answer.state)
      } catch (error) {
        button.disabled = false
        onError(error)
      }
    }
    box.append(button)
    return box
  })
}
