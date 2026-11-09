import { confirmVisit } from './visit.js'
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test.use({ viewport: { width: 390, height: 844 } })

const invoiceLine = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89, she wants the bathroom one done next week.'

async function say(page, text) {
  await page.getByRole('tab', { name: 'Today' }).click()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill(text)
  await page.getByRole('button', { name: 'Send text' }).click()
}

async function sendInvoice(page) {
  await say(page, invoiceLine)
  await confirmVisit(page, page.getByRole('button', { name: /^Send \d/ }))
  await page.getByRole('button', { name: /^Send \d/ }).click()
  await expect(page.locator('#sheet img.qr')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Try saying' })).toBeVisible()
})

test('a draft comes before the notices', async ({ page }) => {
  await sendInvoice(page)
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click()
  await say(page, invoiceLine)
  await expect(page.getByRole('button', { name: /^Send \d/ })).toBeVisible()
  const card = await page.locator('.card').boundingBox()
  const notices = await page.locator('.notices').boundingBox()
  expect(card.y).toBeLessThan(notices.y)
})

test('the reminder box is the full card width', async ({ page }) => {
  await say(page, 'Remind Dave about his invoice.')
  const card = page.locator('.card')
  const reminder = page.locator('.remind-text')
  await expect(reminder).toBeVisible()
  await expect(card).toContainText('Owed')
  const box = await reminder.boundingBox()
  const cardBox = await card.boundingBox()
  const owed = await card.locator('.totals').filter({ hasText: 'Owed' }).boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(cardBox.width - 40)
  expect(box.y).toBeGreaterThanOrEqual(owed.y + owed.height)
})

test('the payment state sits above the QR', async ({ page }) => {
  await sendInvoice(page)
  const status = await page.locator('#sheet .pay-status').boundingBox()
  const qr = await page.locator('#sheet img.qr').boundingBox()
  expect(status.y).toBeLessThan(qr.y)
})

test('owed rows show the amount on the right', async ({ page }) => {
  await sendInvoice(page)
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Owed' }).click()
  await expect(page.locator('.owed-summary .money')).toBeVisible()
  const row = page.locator('.owed-row').first()
  const amount = await row.locator('.row-amount').boundingBox()
  const name = await row.locator('strong').boundingBox()
  expect(amount.x).toBeGreaterThan(name.x)
  expect(Math.abs(amount.y - name.y)).toBeLessThan(12)
})

test('late invoices come first in Owed, and an amount opens its invoice', async ({ page }) => {
  await sendInvoice(page)
  await page.locator('#sheet').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Owed' }).click()
  // The demo starts with Sam's invoice sent on 24 Oct 2026 (late) and Dave's from yesterday; Maria's is new.
  await expect(page.locator('.owed-group')).toHaveText(['Late', 'Waiting'])
  const order = await page.locator('.owed-list').evaluate((list) => [...list.children].map((el) => el.classList.contains('owed-group') ? el.textContent : 'row'))
  expect(order[0]).toBe('Late')
  expect(order.indexOf('Waiting')).toBeGreaterThan(1)
  await page.locator('.owed-row').first().click()
  await expect(page.locator('#sheet:not([hidden])')).toBeVisible()
})

test('a booking shows label and value rows', async ({ page }) => {
  await say(page, 'Book the bathroom tap for Maria next week.')
  await expect(page.locator('.card')).toContainText('One hour by default.')
  const rows = page.locator('.card .totals')
  await expect(rows).toHaveCount(3)
  for (const [index, label] of ['When', 'Held for', 'Deposit'].entries()) {
    await expect(rows.nth(index).locator('span').first()).toHaveText(label)
  }
})

test('a paid sheet has a Done button that closes it', async ({ page }) => {
  await say(page, 'Dave paid cash, 108.')
  await page.getByRole('button', { name: 'Record cash' }).click()
  await page.locator('a.notice').first().click()
  const sheet = page.locator('#sheet')
  await expect(sheet.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(sheet).toBeHidden()
})
