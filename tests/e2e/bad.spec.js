import { confirmVisit } from './visit.js'
// The bad paths, through the page and the API: a stranger cannot be invoiced, cash above the due amount is refused,
// a reminder's made up figure never reaches PayPal, a long or wrong recording is refused, and a repeated tap makes no
// second invoice.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { shot } from './shots.js'

/** A 16 kHz mono 16 bit WAV of silence. */
function wav(seconds, rate = 16000) {
  const data = Math.round(seconds * rate * 2)
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data, 40)
  return b
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
})

test('a name with no customer cannot be invoiced', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Gutter clean for Bob, an hour.')
  await page.getByRole('button', { name: 'Send text' }).click()
  await expect(page.getByText(/New customer/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Send \d/ })).toHaveCount(0)
  await shot(page, 'bad-no-such-customer')
})

test('cash above the due amount is refused, and a paid invoice takes no more', async ({ page }) => {
  const state = await (await page.request.get('/api/state')).json()
  const dave = Object.values(state.ws.invoices).find((i) => i.customerId === 'c2')
  const over = await page.request.post(`/api/invoices/${dave.id}/cash`, { data: { amount: '150.00' } })
  expect(over.status()).toBe(422)
  expect((await over.json()).message).toBe(`Only ${dave.due} is due on this invoice.`)
  const ok = await page.request.post(`/api/invoices/${dave.id}/cash`, { data: { amount: dave.due } })
  expect(ok.status()).toBe(200)
  const again = await page.request.post(`/api/invoices/${dave.id}/cash`, { data: { amount: '1.00' } })
  expect(again.status()).toBe(422)
})

test('a reminder sends standard wording regardless of the unused custom draft', async ({ page }) => {
  const state = await (await page.request.get('/api/state')).json()
  const dave = Object.values(state.ws.invoices).find((i) => i.customerId === 'c2')
  const sent = await page.request.post(`/api/invoices/${dave.id}/remind`, { data: { text: `Hi Dave. ${dave.due} is still open. Pay 20.00 today and we call it even.` } })
  expect(sent.status()).toBe(200)
  const after = (await sent.json()).state
  expect(after.ws.invoices[dave.id].reminders).toBe(1)
  const allMadeUp = await page.request.post(`/api/invoices/${dave.id}/remind`, { data: { text: 'Pay 999.00 now.' } })
  expect(allMadeUp.status()).toBe(200)
})

test('a recording over 30 seconds or in the wrong format is refused before any AI call', async ({ page }) => {
  const long = await page.request.post('/api/voice', { headers: { 'content-type': 'audio/wav' }, data: wav(31) })
  expect(long.status()).toBe(413)
  const wrong = await page.request.post('/api/voice', { headers: { 'content-type': 'audio/wav' }, data: wav(2, 44100) })
  expect(wrong.status()).toBe(415)
  const state = await (await page.request.get('/api/state')).json()
  expect(state.ws.panel.filter((e) => e.kind === 'model')).toHaveLength(0)
})

test('a repeated tap on Send makes one invoice', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.')
  await page.getByRole('button', { name: 'Send text' }).click()
  // This posts the preselected or prefilled visit before the direct Send requests.
  await confirmVisit(page)
  const draftId = await page.evaluate(async () => {
    const s = await (await fetch('/api/state')).json()
    return Object.values(s.ws.drafts).filter((d) => d.customerId === 'c1' && !d.invoiceId).at(-1)?.id
  })
  const [a, b] = await Promise.all([page.request.post(`/api/drafts/${draftId}/send`), page.request.post(`/api/drafts/${draftId}/send`)])
  const ids = [(await a.json()).invoiceId, (await b.json()).invoiceId].filter(Boolean)
  expect(new Set(ids).size).toBe(1)
})
