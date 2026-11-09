// Records the demo footage for the video (not a test of behaviour). Runs only with CAPTURE=1:
// CAPTURE=1 BASE_URL=<hosted url> npx playwright test tests/e2e/capture.spec.js
// The page is recorded at 1920 x 1080: the phone on the left, the "Behind the scenes" panel on the right. Speech comes
// from tools/out/<line>.wav through Chrome's test microphone, so "Hold to talk" runs through Whisper for real. The
// customer's phone is recorded in its own clips at double density. Clips land in capture/.
// PayPal's own pages show the sandbox account emails: the edit crops them to the QR and the amount.
// It also writes capture/marks.json: the seconds into each clip at which each moment happened, the box of the thing
// each moment is about (marks.focus, fractions of the page), the phone and panel boxes (marks.boxes), and how the first
// payment was seen (marks.paidSource). tools/film_timeline.py cuts and zooms on these.
// Every step uses the page's own controls. The two minute demo hold runs out by itself: no "Run out the hold now" tap.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { payOnPayPal } from './pay.js'
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

test.skip(!process.env.CAPTURE, 'footage only on request')
test.setTimeout(1_200_000)

const OUT = resolve('capture')
const VIEW = { width: 1536, height: 864 }
const secretsFile = join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt')
const buyer = existsSync(secretsFile)
  ? Object.fromEntries(readFileSync(secretsFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {}
const login = () => ({ email: buyer.PAYPAL_SANDBOX_BUYER_EMAIL, password: buyer.PAYPAL_SANDBOX_BUYER_PASSWORD })

/** A browser whose test microphone plays the given clip. */
async function recorder(browserType, clip, size, name, scale = 1) {
  const browser = await browserType.launch({
    headless: true,
    // Chrome's own file microphone plays from browser start: a looping clip was heard from a random point (the note
    // came out nearly twice), and a %noloop clip had ended before the press (runs of 9 Nov 2026). So the microphone
    // below plays the clip once from its start on each press instead.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const video = { width: size.width * scale, height: size.height * scale }
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: scale, recordVideo: { dir: join(OUT, name), size: video }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] })
  await maintainer(context)
  if (clip) await context.addInitScript((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext()
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0))
      const source = ctx.createBufferSource()
      const out = ctx.createMediaStreamDestination()
      source.buffer = buffer
      source.connect(out)
      source.start()
      const [track] = out.stream.getAudioTracks()
      const stop = track.stop.bind(track)
      track.stop = () => { stop(); source.stop(); ctx.close() }
      return out.stream
    }
  }, readFileSync(resolve(clip)).toString('base64'))
  return { browser, context }
}

/** The owner's maintainer pass (the jd_maint cookie), so the long capture is not stopped by one visitor's daily caps.
 *  The token is read from the local deploy file and is never printed. */
async function maintainer(context) {
  const file = resolve('.deploy.local.json')
  const base = process.env.BASE_URL
  if (!base || !existsSync(file)) return
  const token = JSON.parse(readFileSync(file, 'utf8')).maintainerToken
  if (typeof token !== 'string' || !token) return
  await context.addCookies([{ name: 'jd_maint', value: token, domain: new URL(base).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
}

/** Holds the talk button for the clip's length, or types the line when speech is not available. */
async function speak(page, text, seconds) {
  const talk = page.getByRole('button', { name: 'Hold to talk' })
  const box = await talk.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(seconds * 1000 + 400)
  await page.mouse.up()
  const typed = page.getByRole('textbox', { name: 'Describe the job' })
  // Speech to text once took longer than 15 s (9 Nov run): the line was typed too and the late words stayed in the box.
  await expect(typed).toHaveValue(/\w/, { timeout: 40_000 }).catch(async () => {
    marks.typedInstead = true
    console.log('capture: speech gave no words; the line was typed')
    await typed.pressSequentially(text, { delay: 35 })
    await page.getByRole('button', { name: 'Send text' }).click()
  })
}

/** Types a line on the Today tab and sends it; resolves when the agent has answered. */
async function say(page, line) {
  await page.getByRole('tab', { name: 'Today' }).click()
  const answered = page.waitForResponse((r) => r.url().includes('/api/agent'), { timeout: 60_000 })
  // Words left in the box (a question back keeps them) would run into this line.
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('')
  await page.getByRole('textbox', { name: 'Describe the job' }).pressSequentially(line, { delay: 30 })
  await page.getByRole('button', { name: 'Send text' }).click()
  await answered
}

/** Seconds into each clip at which each moment happened, for the edit. */
const marks = { focus: {} }
function clock(clip) {
  const t0 = Date.now()
  marks[clip] = {}
  marks.starts = { ...(marks.starts ?? {}), [clip]: t0 }
  return (name) => { (marks[clip][name] ??= []).push(Math.round((Date.now() - t0) / 100) / 10) }
}

/** Scrolls the thing into the middle of its scrolling area and records its box for the zoom. */
async function focus(name, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {})
  await locator.page().waitForTimeout(400)
  const box = await locator.boundingBox().catch(() => null)
  if (box) marks.focus[name] = [box.y / VIEW.height, (box.y + box.height) / VIEW.height].map((v) => Math.round(v * 1000) / 1000)
}

/** The workspace as the page sees it. */
const workspace = (page) => page.evaluate(async () => { const s = await (await fetch('/api/state')).json(); return s.ws ?? s.state?.ws })

/** Opens the Calendar on the week that holds the job, and waits for the job in the given state. */
async function calendarAt(page, jobId, state) {
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const block = page.locator(`[data-job-id="${jobId}"]${state ? `[data-state="${state}"]` : ''}:visible`).first()
  // The calendar keeps the week it was left on, so look on this week, then the next, then the one before.
  const move = (ref) => page.locator(`.b-calendar .b-top-toolbar [data-ref="${ref}"]`).first().click().catch(() => {})
  for (const step of [null, 'nextButton', 'prevButton', 'prevButton']) {
    if (step) await move(step)
    if (await block.isVisible({ timeout: 4_000 }).catch(() => false)) break
  }
  await expect(block).toBeVisible({ timeout: 20_000 })
  return block
}

async function save(page, context, name) {
  const video = page.video()
  await context.close()
  if (video) renameSync(await video.path(), join(OUT, `${name}.webm`))
}

/** Pays one invoice on PayPal's page in its own customer clip. */
async function customerPays(playwright, cookies, name, url, o, marker) {
  const customer = await recorder(playwright.chromium, null, { width: 390, height: 844 }, name, 2)
  const phone = await customer.context.newPage()
  const markPhone = clock(name)
  await customer.context.addCookies(cookies)
  await marker(phone, markPhone)
  await phone.goto(url)
  markPhone('paypal-page')
  await payOnPayPal(phone, login(), { ...o, beforePay: async () => { markPhone(`${name === 'customer' ? 'tip-typed' : `${name}-pay`}`); await phone.waitForTimeout(2500); markPhone('pay-tap') } })
  await phone.waitForTimeout(5000)
  await save(phone, customer.context, name)
  await customer.browser.close()
}

test('capture the demo', async ({ playwright }) => {
  mkdirSync(OUT, { recursive: true })
  // 1536 x 864 at 1.25 pixel density records 1920 x 1080; a CSS zoom instead would stop Bryntum's drag.
  const main = await recorder(playwright.chromium, 'tools/out/maria.wav', VIEW, 'main', 1.25)
  const page = await main.context.newPage()
  const mark = clock('main')
  await page.goto('/?calendar=bryntum&video=1')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.waitForTimeout(1500)
  marks.boxes = await page.evaluate(([w, h]) => {
    const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? [r.x / w, r.y / h, r.width / w, r.height / h].map((v) => Math.round(v * 1000) / 1000) : null }
    return { phone: box('.phone'), panel: box('.side-panel') }
  }, [VIEW.width, VIEW.height])
  const sheet = page.locator('#sheet:not([hidden])')

  // 1. The job, spoken; Maria's draft.
  mark('talk')
  const LINE = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.'
  await speak(page, LINE, 8.8)
  const send = page.getByRole('button', { name: /^Send \d/ })
  // If the note does not become Maria's draft (speech to text once heard "hour in a half"; the model once read
  // "maria" as a new customer), the film shows the fix: the words come back (they stay in the box after a question,
  // or "Edit job note" puts them back), are corrected by typing, and are sent again. Nothing is hidden.
  const question = page.getByText(/^(How long is the visit|Which day|What did the part cost|Which customer)/).first()
  const editNote = page.getByRole('button', { name: 'Edit job note' }).first()
  const box = page.getByRole('textbox', { name: 'Describe the job' })
  // The guard may refuse the model's answer ("I could not back that up"): the words stay in the box and go again as they are.
  const dropped = page.getByText(/I could not back that up/).first()
  const plain = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(send.or(question).or(editNote).or(dropped).first()).toBeVisible({ timeout: 40_000 })
    await page.waitForTimeout(800)
    if (await send.isVisible()) break
    if (await dropped.isVisible() && !(await question.isVisible()) && !(await editNote.isVisible())) {
      console.log('capture: the guard dropped the answer; the same words are sent again')
      if (attempt === 0) {
        marks.dropped = true
        marks.heard = await box.inputValue()
        await focus('question', box)
        mark('question')
        await page.waitForTimeout(3500)
      }
      const again = page.waitForResponse((r) => r.url().includes('/api/agent'), { timeout: 60_000 })
      await page.getByRole('button', { name: 'Send text' }).click()
      if (attempt === 0) mark('fix-sent')
      await again
      continue
    }
    if (await editNote.isVisible()) await editNote.click()
    const heard = await box.inputValue()
    if (attempt === 0) {
      marks.heard = heard
      marks.misheard = plain(heard) !== plain(LINE)
      console.log(`capture: not a draft (${(await question.isVisible()) ? 'a question back' : 'another card'}); heard "${heard}"`)
      await focus('question', box)
      mark('question')
      await page.waitForTimeout(3500)
    }
    await box.fill('')
    await box.pressSequentially('Kitchen tap for Maria Lopez at 14 Elm, an hour and a half, the tap was 89, she wants the bathroom one done next week.', { delay: 30 })
    const answered = page.waitForResponse((r) => r.url().includes('/api/agent'), { timeout: 60_000 })
    await page.getByRole('button', { name: 'Send text' }).click()
    if (attempt === 0) mark('fix-sent')
    await answered
  }
  await expect(send).toBeVisible({ timeout: 40_000 })
  const card = page.locator('article.card').filter({ has: send })
  await focus('draft', card.locator('.step-job').first())
  mark('draft')
  await page.waitForTimeout(6000)

  // 2. The visit step: check the times, then confirm. Send waits until then.
  await focus('visit-review', card.locator('.step-visit'))
  mark('visit-review')
  await page.waitForTimeout(3000)
  await card.getByRole('button', { name: 'Confirm visit', exact: true }).click()
  await expect(send).toBeEnabled({ timeout: 40_000 })
  await focus('visit-confirmed', card.locator('.step-visit'))
  mark('visit-confirmed')
  await page.waitForTimeout(3000)

  // 3. One tap sends it; the QR sheet; the customer pays with a 10.00 tip in their own clip.
  await focus('send-tap', send)
  mark('send-tap')
  await send.click()
  await expect(sheet.getByRole('img', { name: 'Payment QR code' })).toBeVisible({ timeout: 20_000 })
  mark('qr')
  await page.waitForTimeout(3000)
  const invoiceId = await sheet.getAttribute('data-invoice-id')
  const payUrl = await sheet.getByRole('link', { name: 'Open the PayPal page' }).getAttribute('href')
  await customerPays(playwright, await main.context.cookies(), 'customer', payUrl, { tip: '10.00' }, async (phone, markPhone) => {
    await phone.goto(`/customer.html?inv=${invoiceId}`)
    await phone.waitForFunction(() => { const i = document.querySelector('#qr'); return !!i && i.complete && i.naturalWidth > 0 }, null, { timeout: 15_000 })
    markPhone('customer-qr')
    await phone.waitForTimeout(3000)
  })

  // 4. Paid lands on the tradesperson's phone. How it was seen (webhook or status check) is read from the app's state.
  await expect(sheet.getByText(/Paid/)).toBeVisible({ timeout: 120_000 })
  mark('paid')
  marks.paidSource = (await workspace(page).catch(() => null))?.invoices?.[invoiceId]?.paidBy ?? null
  console.log(`capture: the payment was seen by ${marks.paidSource ?? 'an unknown route'}`)
  await page.waitForTimeout(3500)
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.waitForTimeout(600)
  marks.focus['calendar-paid'] = marks.boxes.phone && [marks.boxes.phone[1], marks.boxes.phone[1] + 0.3]
  mark('calendar-paid')
  await page.waitForTimeout(4000)

  // 6. Booking A: the earliest free slot, a deposit, paid by the customer: booked.
  await say(page, 'Book the bathroom tap for Maria next week.')
  const depositButton = page.locator('article.card').filter({ hasText: /bathroom/i }).getByRole('button', { name: /Send deposit/ }).or(page.getByRole('button', { name: /Send deposit/ })).first()
  await depositButton.waitFor({ timeout: 40_000 })
  await focus('booking-card', page.locator('article.card').filter({ has: depositButton }).first())
  mark('booking-card')
  await page.waitForTimeout(3500)
  mark('deposit-tap')
  await depositButton.click()
  await expect(sheet.getByRole('link', { name: 'Open the PayPal page' })).toBeVisible({ timeout: 20_000 })
  const depositA = await sheet.getAttribute('data-invoice-id')
  const depositUrl = await sheet.getByRole('link', { name: 'Open the PayPal page' }).getAttribute('href')
  const jobA = (await workspace(page))?.invoices?.[depositA]?.jobId
  await customerPays(playwright, await main.context.cookies(), 'customer2', depositUrl, {}, async () => {})
  await expect(sheet.getByText(/Paid/)).toBeVisible({ timeout: 120_000 })
  await sheet.getByRole('button', { name: 'Close' }).click()
  try {
    const block = await calendarAt(page, jobA, 'booked')
    await focus('booked', block)
    mark('booked')
    await page.waitForTimeout(3000)
  } catch (e) {
    console.log(`capture: booked shot dropped (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // 7. The visit is done: its bill takes the paid deposit off. Not sent.
  try {
    await say(page, 'Bathroom tap for Maria, an hour, the tap was 120.')
    const creditSend = page.getByRole('button', { name: /^Send \d/ }).last()
    await expect(creditSend).toBeVisible({ timeout: 40_000 })
    const creditCard = page.locator('article.card').filter({ has: creditSend }).last()
    await creditCard.locator('select[name="jobId"]').selectOption(jobA)
    await creditCard.getByRole('button', { name: 'Confirm visit', exact: true }).click()
    await expect(creditCard.getByText('Paid deposit')).toBeVisible({ timeout: 40_000 })
    await expect(creditCard.getByText('Remaining balance')).toBeVisible()
    await focus('credit', creditCard.locator('.totals').first())
    mark('credit')
    await page.waitForTimeout(6000)
  } catch (e) {
    console.log(`capture: credit shot dropped (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // 9. Booking B is left unpaid. While its two minute hold runs, the waiting list is set with the page's own form.
  try {
  await say(page, 'Book a radiator check for Maria next week.')
  const depositB = page.locator('article.card').filter({ hasText: /radiator/i }).getByRole('button', { name: /Send deposit/ }).or(page.getByRole('button', { name: /Send deposit/ })).first()
  await depositB.waitFor({ timeout: 40_000 })
  await focus('hold-card', page.locator('article.card').filter({ has: depositB }).first())
  mark('hold-card')
  await page.waitForTimeout(2000)
  await depositB.click()
  await expect(sheet.getByRole('link', { name: 'Open the PayPal page' })).toBeVisible({ timeout: 20_000 })
  const holdInvoice = await sheet.getAttribute('data-invoice-id')
  await sheet.getByRole('button', { name: 'Close' }).click()
  const ws = await workspace(page)
  const jobB = ws?.invoices?.[holdInvoice]?.jobId
  const held = ws?.jobs?.find((j) => j.id === jobB)
  const block = await calendarAt(page, jobB, 'held')
  await focus('held', block)
  mark('held')
  await page.waitForTimeout(4500)

  // 8. Waiting list, in order: Dave (too long for the slot), Sam (free only at the other half of the day), Priya (fits).
  const hours = held ? (Date.parse(held.end) - Date.parse(held.start)) / 3_600_000 : 1
  const startHour = held ? new Date(Date.parse(held.start) + ws.tz * 60_000).getUTCHours() : 9
  const plan = [
    { id: 'c2', summary: 'New bathroom suite', hours: Math.min(8, Math.ceil(hours) + 2), free: 'any' },
    { id: 'c3', summary: 'Outside tap', hours: 1, free: startHour < 12 ? 'afternoons' : 'mornings' },
    { id: 'c4', summary: 'Leak under the sink', hours: 1, free: 'any' },
  ]
  // The waiting list, the freed slot's offer and its panel all sit under the calendar on the Calendar tab.
  // If the list cannot be set, the demo's own waiting job (Priya) still takes the slot.
  try {
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const list = page.getByRole('region', { name: 'Waiting list', exact: true })
  const rows = list.locator('[data-waiting-id]')
  for (let left = await rows.count(); left > 0; left--) {
    await rows.first().getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(rows).toHaveCount(left - 1, { timeout: 15_000 })
  }
  for (const [i, w] of plan.entries()) {
    await list.getByLabel('Customer', { exact: true }).selectOption(w.id)
    await list.getByLabel('Summary', { exact: true }).fill(w.summary)
    await list.getByLabel('Hours', { exact: true }).selectOption(String(w.hours))
    await list.getByLabel('When free', { exact: true }).selectOption(w.free)
    await list.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(rows).toHaveCount(i + 1, { timeout: 15_000 })
  }
  mark('waiting-set')
  console.log(`capture: freed slot ${hours} h from ${startHour}:00; Dave ${plan[0].hours} h, Sam ${plan[1].free}`)
  } catch (e) {
    console.log(`capture: waiting list not set (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // The real hold runs out (the page polls; the server releases it), the deposit invoice is cancelled, the slot is offered.
  const offer = page.locator('[data-keep^="accept-"]').first()
  await expect(offer).toBeVisible({ timeout: 240_000 })
  await focus('freed', offer)
  mark('freed')
  await page.waitForTimeout(4500)
  const why = page.locator('details.recovery').first()
  await focus('why', why)
  mark('why')
  await page.waitForTimeout(8000)
  await focus('offer-sent', offer)
  await offer.click()
  await expect(sheet).toBeVisible({ timeout: 20_000 })
  mark('offer-sent')
  await page.waitForTimeout(3000)
  await sheet.getByRole('button', { name: 'Close' }).click()
  } catch (e) {
    console.log(`capture: hold and freed shots short (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
    await page.locator('#sheet:not([hidden])').getByRole('button', { name: 'Close' }).click({ timeout: 3_000 }).catch(() => {})
  }

  // 10. Owed: late invoices first; one opened from its amount.
  try {
    await page.getByRole('tab', { name: 'Owed' }).click()
    await page.waitForTimeout(600)
    await focus('owed-tab', page.locator('.owed-summary').first())
    mark('owed-tab')
    await page.waitForTimeout(3000)
    await page.locator('.owed-row').first().click()
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    mark('owed-open')
    await page.waitForTimeout(3500)
    await sheet.getByRole('button', { name: 'Close' }).click()
  } catch (e) {
    console.log(`capture: owed shot short (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // 11. A reminder: Copy message copies your own words; Send PayPal reminder sends PayPal's standard one.
  // The full name: with "Sam" alone the model once looked up two customers and the guard asked for one (9 Nov run).
  // A refused answer is sent again once; the shot starts on the card, so the retry is not in the cut.
  const remindButton = page.getByRole('button', { name: 'Send PayPal reminder' }).last()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await say(page, 'Remind Sam Okafor about his invoice.')
      if (await remindButton.isVisible({ timeout: 8_000 }).catch(() => false)) break
      console.log('capture: the reminder line was not a reminder card; sent again')
      await page.getByRole('textbox', { name: 'Describe the job' }).fill('')
    }
    await expect(remindButton).toBeVisible({ timeout: 20_000 })
    const remindCard = page.locator('article.card').filter({ has: remindButton }).last()
    await focus('remind-card', remindCard)
    mark('remind-card')
    await page.waitForTimeout(3000)
    await remindCard.getByRole('button', { name: 'Copy message' }).click()
    mark('copy-tap')
    await page.waitForTimeout(2500)
    await remindButton.click()
    mark('remind-tap')
    await page.waitForTimeout(3500)
  } catch (e) {
    console.log(`capture: reminder shot short (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // 12. What am I owed? Each amount links to its invoice.
  mark('owed-say')
  await say(page, 'What am I owed?')
  await page.waitForTimeout(1200)
  await focus('owed-card', page.locator('article.card').last())
  mark('owed-card')
  await page.waitForTimeout(5000)

  // 13. The calendar to end.
  await page.getByRole('tab', { name: 'Calendar' }).click()
  marks.focus['calendar-end'] = marks.boxes.phone && [marks.boxes.phone[1], marks.boxes.phone[1] + 0.3]
  mark('calendar-end')
  await page.waitForTimeout(5000)
  await save(page, main.context, 'main')
  await main.browser.close()
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1))
})
