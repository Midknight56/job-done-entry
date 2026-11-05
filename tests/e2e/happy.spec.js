import { confirmVisit } from './visit.js'
// The happy path a judge sees, through the page: talk, send, the customer pays on PayPal's sandbox page, the job
// turns green, the follow up is booked with a deposit, cash is recorded, and "What am I owed?" answers.
// The payment signs in as the sandbox buyer (set 22 Oct 2026); it is skipped where no login is on disk.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { shot } from './shots.js'
import { payOnPayPal } from './pay.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const secretsFile = join(homedir(), '.cloudflare', 'paypal-sandbox.local.txt')
const buyer = existsSync(secretsFile)
  ? Object.fromEntries(readFileSync(secretsFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {}

async function say(page, text) {
  await page.getByRole('tab', { name: 'Today' }).click()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill(text)
  await page.getByRole('button', { name: 'Send text' }).click()
}

/** Pays the invoice on PayPal's sandbox page as the sandbox buyer, in a second tab. */
async function payAsBuyer(context, url) {
  const tab = await context.newPage()
  await tab.goto(url)
  await payOnPayPal(tab, { email: buyer.PAYPAL_SANDBOX_BUYER_EMAIL, password: buyer.PAYPAL_SANDBOX_BUYER_PASSWORD })
  await tab.close()
}

test('happy path: talk, send, paid, booked, cash, owed', async ({ page, context }) => {
  test.setTimeout(300_000)
  test.skip(!buyer.PAYPAL_SANDBOX_BUYER_PASSWORD, 'no sandbox buyer login on this machine')
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()

  await say(page, 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.')
  await expect(page.getByText('you said 89')).toBeVisible()
  await shot(page, 'happy-maria-draft')
  await confirmVisit(page, page.getByRole('button', { name: 'Send 282.42' }))
  await page.getByRole('button', { name: 'Send 282.42' }).click()
  const sheet = page.locator('#sheet:not([hidden])')
  await expect(sheet).toBeVisible()
  const invoiceId = await sheet.getAttribute('data-invoice-id')
  const sentState = await (await page.request.get('/api/state')).json()
  const jobId = sentState.ws.invoices[invoiceId].jobId
  await expect(sheet.getByRole('img', { name: 'Payment QR code' })).toBeVisible()
  await expect(sheet.getByText('Waiting for payment')).toBeVisible()
  await shot(page, 'happy-qr-sheet')
  const payUrl = await sheet.getByRole('link', { name: 'Open the PayPal page' }).getAttribute('href')
  expect(payUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//)

  await payAsBuyer(context, payUrl)
  await expect(sheet.getByText(/Paid/)).toBeVisible({ timeout: 90_000 })
  await shot(page, 'happy-paid-by-webhook')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator(`[data-job-id="${jobId}"]`).first()).toHaveAttribute('data-state', 'paid')
  await shot(page, 'happy-calendar-green')

  await say(page, 'Book the bathroom tap for Maria next week.')
  await page.getByRole('button', { name: /Send deposit 50.00/ }).click()
  await expect(page.locator('#sheet:not([hidden])')).toBeVisible()
  await shot(page, 'happy-deposit-sheet')
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click()

  await say(page, 'Dave paid cash, 108.')
  await page.getByRole('button', { name: 'Record cash' }).click()
  await expect(page.getByText('Dave Chen paid 108.00 in cash.')).toBeVisible()
  await shot(page, 'happy-cash')

  await say(page, 'What am I owed?')
  await expect(page.locator('.card').getByText(/50.00/).first()).toBeVisible()
  await shot(page, 'happy-owed')

  const panel = page.locator('.side-panel')
  await expect(panel.getByText('POST /v2/invoicing/invoices').first()).toBeVisible()
})
