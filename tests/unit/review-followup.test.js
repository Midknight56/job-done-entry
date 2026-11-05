import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestedDates } from '../../src/agent/dates.js'
import { runTurn } from '../../src/agent/loop.js'
import { seedWorkspace } from '../../src/state/workspace.js'
import { renderProposal } from '../../public/cards.js'
import { replayLines, replayModel } from '../../src/agent/replay.js'

const day = 86400000
const now = Date.parse('2026-11-05T14:00:00Z')
afterEach(() => vi.unstubAllGlobals())

describe.each(['2026-11-03', '2026-11-05'])('spoken weekdays on %s', (today) => {
  // UTC is already the next day; the workspace is still Tuesday / Thursday.
  const clock = Date.parse(today + 'T23:30:00-04:00')
  it.each(['Thursday', 'on Thursday', 'this Thursday', 'next Thursday', 'Thursday morning'])('%s', (phrase) => {
    const date = phrase === 'next Thursday' ? '2026-11-12' : '2026-11-05'
    const after = Date.parse(date + 'T00:00:00-04:00')
    expect(requestedDates('Book Maria ' + phrase, clock, -240)).toEqual({
      after, before: after + day, period: phrase.endsWith('morning') ? 'morning' : null,
    })
  })
})

it.each(['Thursday or Friday', 'Thursday Friday', 'tomorrow Thursday', 'next week Thursday', 'Thursday at 3pm', 'Thursday 15:00', 'Thursday noon', 'Thursday morning afternoon'])('keeps ambiguous or timed request unresolved: %s', (phrase) => {
  expect(requestedDates('Book Maria ' + phrase, now, -240)).toBeNull()
})

it('asks for a spoken day when the date is missing', async () => {
  const ws = seedWorkspace({ id: 'followup', now, tzOffsetMinutes: -240 })
  const callModel = vi.fn(async () => ({ text: JSON.stringify({ calls: [{ tool: 'find_slots', args: {} }] }), neurons: 0 }))
  const result = await runTurn(ws, 'Book Maria sometime', { now, callModel })
  expect(result.message).toBe('Which day? Say one day, like tomorrow or Thursday.')
  expect(callModel).toHaveBeenCalledOnce()
})

// Minimal DOM controls exercise the real card initialization and submit handlers.
function invoiceCard(jobs, visitFields, options = {}) {
  const elements = []
  function element(tag) {
    const nodes = {}
    const el = { tag, dataset: {}, classList: { contains: () => false },
      append() {}, before() {}, after() {}, getAttribute: () => null,
      querySelector: (selector) => nodes[selector] ||= element(selector),
      querySelectorAll: (selector) => selector === 'input, select'
        ? (nodes.controls ||= ['jobId', 'start', 'end'].map((name) => ({ name }))) : [],
    }
    elements.push(el)
    return el
  }
  vi.stubGlobal('document', { createElement: element })
  const proposal = { kind: 'invoice', draftId: 'd1', customerId: 'c1', customer: 'Maria', needsVisit: true,
    priced: { lines: options.lines || [], total: '100.00' }, ...(visitFields ? { visitFields } : {}) }
  const post = vi.fn(async () => ({ draft: { jobId: 'nearest', priced: proposal.priced }, state: {} }))
  const card = renderProposal(proposal, { state: { now: options.now ?? now, ws: { jobs, tz: options.tz ?? -240 } }, money: String, esc: String,
    post, onUpdate: vi.fn(), onError: (error) => { throw error } })
  const form = elements.find((el) => el.tag === 'form')
  return { card, form, post, proposal, select: form.querySelectorAll('input, select')[0] }
}

const visit = (id, offset, extra = {}) => ({ id, customerId: 'c1', state: 'booked', summary: id,
  start: new Date(now + offset).toISOString(), ...extra })

it('preselects the nearest booked visit and still requires Confirm visit', async () => {
  const { select, card, form, post, proposal } = invoiceCard([
    visit('farther', -20 * 3600000), visit('completed', 0, { state: 'completed' }),
    visit('other-customer', 0, { customerId: 'c2' }), visit('nearest', 2 * 3600000),
    visit('later', 8 * 3600000),
  ])
  expect(select.value).toBe('nearest')
  expect(card.querySelector('.primary').disabled).toBe(true)
  expect(post).not.toHaveBeenCalled()
  await form.onsubmit({ preventDefault() {} })
  expect(post).toHaveBeenCalledWith('/api/drafts/d1/visit', { jobId: 'nearest' })
  expect(proposal.needsVisit).toBe(false)
})

it('leaves a new completed visit selected when no booking is within one day', () => {
  const { select, proposal } = invoiceCard([visit('old', -day - 1), visit('future', day + 1), visit('done', 0, { state: 'completed' })])
  expect(select.value).toBe('')
  expect(proposal.visitFields).toEqual({ jobId: '', start: '2026-11-05T09:00', end: '2026-11-05T10:00' })
})

it.each([
  [-240, '2026-11-05T08:30', '2026-11-05T10:00'],
  [330, '2026-11-05T18:00', '2026-11-05T19:30'],
  [840, '2026-11-06T02:30', '2026-11-06T04:00'],
])('prefills completed labour in calendar time zone %s and confirms explicitly', async (tz, start, end) => {
  const { card, form, post, proposal } = invoiceCard([], undefined, {
    now: Date.parse('2026-11-05T14:03:59Z'), tz,
    lines: [{ kind: 'part', quantity: '7' }, { kind: 'labour', quantity: '1.5' }],
  })
  expect(proposal.visitFields).toEqual({ jobId: '', start, end })
  expect(form.querySelectorAll('input, select').map((control) => control.value)).toEqual(['', start, end])
  expect(card.querySelector('.primary').disabled).toBe(true)
  expect(post).not.toHaveBeenCalled()
  await form.onsubmit({ preventDefault() {} })
  expect(post).toHaveBeenCalledWith('/api/drafts/d1/visit', {
    start: '2026-11-05T12:30:00.000Z', end: '2026-11-05T14:00:00.000Z',
  })
  expect(proposal.needsVisit).toBe(false)
})

it('adds the hours of all priced labour lines', () => {
  const { proposal } = invoiceCard([], undefined, { lines: [
    { kind: 'labour', quantity: '0.5' }, { kind: 'labour', quantity: '1' },
  ] })
  expect(proposal.visitFields).toEqual({ jobId: '', start: '2026-11-05T08:30', end: '2026-11-05T10:00' })
})

it.each([-day, day])('includes a booked visit exactly one day away (%s ms)', (offset) => {
  expect(invoiceCard([visit('boundary', offset)]).select.value).toBe('boundary')
})

it('preserves an explicit new-visit choice and its times on redraw', () => {
  const fields = { jobId: '', start: '2026-11-05T08:00', end: '2026-11-05T09:00' }
  const { select, proposal } = invoiceCard([visit('nearest', 0)], fields)
  expect(select.value).toBe('')
  expect(proposal.visitFields).toEqual(fields)
})

it('copies only the reminder draft and leaves the server action separate', async () => {
  const controls = {
    '.remind-text': { value: 'Hello', select: vi.fn(), dataset: {}, classList: { contains: () => false }, getAttribute: () => null },
    '.copy-message': { textContent: 'Copy message', classList: { contains: () => false }, dataset: {}, getAttribute: () => null },
    '.primary': { classList: { contains: (name) => name === 'primary' }, dataset: {}, getAttribute: () => null },
  }
  const card = { className: '', dataset: {}, innerHTML: '', append() {}, querySelector: (selector) => controls[selector],
    querySelectorAll: () => Object.values(controls) }
  vi.stubGlobal('document', { createElement: () => card })
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const post = vi.fn(async () => ({}))
  renderProposal({ kind: 'reminder', customer: 'Dave', text: 'Hello', invoiceId: 'INV' }, {
    state: { ws: { invoices: {} } }, money: String, esc: String, customer: String, post,
    onDone: vi.fn(), onError: vi.fn(),
  })
  await controls['.copy-message'].onclick()
  expect(writeText).toHaveBeenCalledWith('Hello')
  expect(controls['.copy-message'].textContent).toBe('Copied')
  expect(post).not.toHaveBeenCalled()
  expect(controls['.primary'].onclick).toBeTypeOf('function')
  writeText.mockRejectedValueOnce(new Error('Clipboard denied'))
  controls['.copy-message'].textContent = 'Copy message'
  await controls['.copy-message'].onclick()
  expect(controls['.remind-text'].select).toHaveBeenCalledOnce()
  expect(controls['.copy-message'].textContent).toBe('Select the text and copy it')
})

it.each(replayLines().map((line, i) => [line, ['invoice', 'booking', 'cash', 'reminder', 'answer'][i]]))('replays the recorded demo: %s', async (line, kind) => {
  const ws = seedWorkspace({ id: 'followup-replay', now, tzOffsetMinutes: 0 })
  ws.invoices.DAVE = { id: 'DAVE', customerId: 'c2', kind: 'invoice', status: 'SENT', total: '108.00', due: '108.00', sentAt: now - day }
  ws.invoices.SAM = { id: 'SAM', customerId: 'c3', kind: 'invoice', status: 'SENT', total: '340.00', due: '340.00', sentAt: now - 10 * day }
  const result = await runTurn(ws, line, { now, callModel: replayModel(line) })
  expect(result.message).toBeNull()
  expect(result.proposal.kind).toBe(kind)
})
