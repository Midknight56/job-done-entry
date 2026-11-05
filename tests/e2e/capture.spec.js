import { confirmVisit } from './visit.js'
// Records the demo footage for the video (not a test of behaviour). Runs only with CAPTURE=1:
// CAPTURE=1 BASE_URL=<hosted url> npx playwright test tests/e2e/capture.spec.js
// The page is recorded at 1920 x 1080: the phone on the left, the "Behind the scenes" panel on the right. Speech comes
// from tools/out/<line>.wav through Chrome's test microphone, so "Hold to talk" runs through Whisper for real. The
// customer's phone (customer.html) is recorded in its own clip at double density. Clips land in capture/.
// PayPal's own pages show the sandbox account emails: the edit crops them to the QR and the amount.
// It also writes capture/marks.json: the seconds into each clip at which each moment happened, which
// tools/film_timeline.py cuts on and tools/film_audio.py places the sound effects on.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { dragJobUp, dragJobOnto } from './calendar-drag.js'
import { payOnPayPal } from './pay.js'
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

test.skip(!process.env.CAPTURE, 'footage only on request')
test.setTimeout(900_000)

const OUT = resolve('capture')
const secretsFile = join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt')
const buyer = existsSync(secretsFile)
  ? Object.fromEntries(readFileSync(secretsFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {}

/** A browser whose test microphone plays the given clip. */
async function recorder(browserType, clip, size, name, scale = 1) {
  const browser = await browserType.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(clip ? [`--use-file-for-fake-audio-capture=${resolve(clip)}`] : [])],
  })
  const video = { width: size.width * scale, height: size.height * scale }
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: scale, recordVideo: { dir: join(OUT, name), size: video }, permissions: ['microphone'] })
  return { browser, context }
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
  await expect(typed).toHaveValue(/\w/, { timeout: 15_000 }).catch(async () => {
    await typed.pressSequentially(text, { delay: 35 })
    await page.getByRole('button', { name: 'Send text' }).click()
  })
}

/** Seconds into each clip at which each moment happened, for the edit. */
const marks = {}
function clock(clip) {
  const t0 = Date.now()
  marks[clip] = {}
  marks.starts = { ...(marks.starts ?? {}), [clip]: t0 }
  return (name) => { (marks[clip][name] ??= []).push(Math.round((Date.now() - t0) / 100) / 10) }
}

async function save(page, context, name) {
  const video = page.video()
  await context.close()
  if (video) renameSync(await video.path(), join(OUT, `${name}.webm`))
}

test('capture the demo', async ({ playwright }) => {
  mkdirSync(OUT, { recursive: true })
  // 1536 x 864 at 1.25 pixel density records 1920 x 1080; a CSS zoom instead would stop Bryntum's drag.
  const size = { width: 1536, height: 864 }
  const main = await recorder(playwright.chromium, 'tools/out/maria.wav', size, 'main', 1.25)
  const page = await main.context.newPage()
  const mark = clock('main')
  await page.goto('/?calendar=bryntum&video=1')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.waitForTimeout(1500)

  // Shot 1: the job, spoken.
  mark('talk')
  await speak(page, 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.', 9)
  await expect(page.getByRole('button', { name: /^Send \d/ })).toBeVisible({ timeout: 40_000 })
  mark('draft')
  await page.waitForTimeout(4000)

  // Shot 2: one tap sends it; the QR sheet.
  mark('send-tap')
  await confirmVisit(page, page.getByRole('button', { name: /^Send \d/ }))
  await page.getByRole('button', { name: /^Send \d/ }).click()
  const sheet = page.locator('#sheet:not([hidden])')
  await expect(sheet.getByRole('img', { name: 'Payment QR code' })).toBeVisible({ timeout: 20_000 })
  mark('qr')
  await page.waitForTimeout(3000)
  const invoiceId = await sheet.getAttribute('data-invoice-id')
  const payUrl = await sheet.getByRole('link', { name: 'Open the PayPal page' }).getAttribute('href')

  // Shot 3: the customer's phone shows the same QR; the buyer pays on PayPal's sandbox page (its own clip).
  const customer = await recorder(playwright.chromium, null, { width: 390, height: 844 }, 'customer', 2)
  const phone = await customer.context.newPage()
  const markPhone = clock('customer')
  const cookies = await main.context.cookies()
  await customer.context.addCookies(cookies)
  await phone.goto(`/customer.html?inv=${invoiceId}`)
  await phone.waitForFunction(() => { const i = document.querySelector('#qr'); return !!i && i.complete && i.naturalWidth > 0 }, null, { timeout: 15_000 })
  markPhone('customer-qr')
  await phone.waitForTimeout(3000)
  await phone.goto(payUrl)
  markPhone('paypal-page')
  // The customer adds a 10.00 tip on PayPal's own pay sheet, then pays the rest in full.
  await payOnPayPal(phone, { email: buyer.PAYPAL_SANDBOX_BUYER_EMAIL, password: buyer.PAYPAL_SANDBOX_BUYER_PASSWORD }, { tip: '10.00', beforePay: async () => { markPhone('tip-typed'); await phone.waitForTimeout(2500); markPhone('pay-tap') } })
  await phone.waitForTimeout(6000)
  await save(phone, customer.context, 'customer')
  await customer.browser.close()

  // Shot 4: Paid lands on the tradesperson's phone and the job turns green.
  await expect(sheet.getByText(/Paid/)).toBeVisible({ timeout: 120_000 })
  mark('paid')
  await page.waitForTimeout(3000)
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  mark('calendar-paid')
  // PayPal's own reminder days for Dave's open invoice show as faint marks; they go when he pays cash.
  const remindersBefore = await page.locator('[data-reminder-of]').count()
  marks.counts = { ...(marks.counts ?? {}), remindersBefore }
  console.log(`capture: ${remindersBefore} reminder marks before the cash`)
  await page.waitForTimeout(4000)

  // Shot 5b: drag Dave's job to the free slot before it, then onto Sam's job to show the clash. A drag that does not
  // land is left out of the film, not faked: the log says which.
  // It runs before the deposit: after the hold, the slot freed notice shrinks the calendar and Dave's afternoon job falls below the visible area.
  try {
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await expect(page.locator('[data-job-id="j4"]').first()).toBeVisible({ timeout: 10_000 })
    mark('drag')
    await dragJobUp(page, 'j4')
    await expect(page.locator('.quiet')).toContainText(/^Moved/, { timeout: 15_000 })
    mark('moved')
    await page.waitForTimeout(3000)
    await dragJobOnto(page, 'j4', 'j3')
    await expect(page.locator('.quiet')).toContainText('clashes with', { timeout: 15_000 })
    mark('clash')
    await page.waitForTimeout(3000)
    console.log('capture: drag shot recorded')
  } catch (e) {
    console.log(`capture: drag shot dropped (${String(e?.message || e).split(String.fromCharCode(10))[0]})`)
  }

  // Shot 5: the follow up is booked with a deposit; the hold runs out; the slot is offered to Priya.
  await page.getByRole('tab', { name: 'Today' }).click()
  await page.getByRole('textbox', { name: 'Describe the job' }).pressSequentially('Book the bathroom tap for Maria next week.', { delay: 35 })
  await page.getByRole('button', { name: 'Send text' }).click()
  await page.getByRole('button', { name: /Send deposit/ }).waitFor({ timeout: 40_000 })
  mark('deposit-tap')
  await page.getByRole('button', { name: /Send deposit/ }).click()
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click({ timeout: 20_000 })
  await page.getByRole('tab', { name: 'Calendar' }).click()
  mark('calendar-held')
  await page.waitForTimeout(4000)
  await expect(page.getByRole('button', { name: /Send deposit/ }).first()).toBeVisible({ timeout: 200_000 })
  mark('freed')
  await page.waitForTimeout(5000)

  // Shot 6: cash, a late reminder, a new call out rate, and what am I owed.
  const lines = [['cash', 'Dave paid cash, 108.'], ['remind', 'Remind Sam about his invoice.'], ['rate', 'Leak check for Priya, half an hour, call out is 60 now.'], ['owed', 'What am I owed?']]
  for (const [name, line] of lines) {
    await page.getByRole('tab', { name: 'Today' }).click()
    mark(`${name}-say`)
    await page.getByRole('textbox', { name: 'Describe the job' }).pressSequentially(line, { delay: 35 })
    await page.getByRole('button', { name: 'Send text' }).click()
    await page.waitForTimeout(6000)
    mark(`${name}-card`)
    const action = page.getByRole('button', { name: /^(Record cash|Send PayPal reminder|Change to \d+\.\d\d)$/ })
    if (await action.isVisible().catch(() => false)) {
      mark(`${name}-tap`)
      await action.click()
      await page.waitForTimeout(4000)
    }
  }
  await page.getByRole('tab', { name: 'Calendar' }).click()
  mark('calendar-end')
  const remindersAfter = await page.locator('[data-reminder-of]').count()
  marks.counts = { ...(marks.counts ?? {}), remindersAfter }
  console.log(`capture: ${remindersAfter} reminder marks after the cash`)
  await page.waitForTimeout(5000)
  await save(page, main.context, 'main')
  await main.browser.close()
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1))
})
