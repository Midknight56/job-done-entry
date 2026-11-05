import { confirmVisit } from './visit.js'
// Reminders PayPal sends by itself: a sent invoice's planned reminders show as faint events on the Bryntum Calendar
// (every 3 days, 3 times, the sandbox account's setting since 28 Oct 2026), and "Stop PayPal reminders" on the
// invoice sheet cancels them at PayPal and takes them off the calendar.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'
import { shot } from './shots.js'

test('a sent invoice shows PayPal’s planned reminders, and stopping them clears the calendar', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/?calendar=bryntum')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.')
  await page.getByRole('button', { name: 'Send text' }).click()
  await confirmVisit(page, page.getByRole('button', { name: 'Send 282.42' }))
  await page.getByRole('button', { name: 'Send 282.42' }).click({ timeout: 40_000 })
  const sheet = page.locator('#sheet:not([hidden])')
  await expect(sheet.getByRole('button', { name: 'Stop PayPal reminders' })).toBeVisible({ timeout: 30_000 })
  const invoiceId = await sheet.getAttribute('data-invoice-id')
  await sheet.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  // The week view hides weekends, so a reminder that falls on one is drawn but not shown.
  const reminders = page.locator(`.b-cal-event-wrap:has([data-reminder-of="${invoiceId}"])`).filter({ visible: true })
  // Reminders fall 3, 6 and 9 days on.
  // Sent on a weekday, at least one of the first two falls on a weekday this week or next.
  await page.waitForTimeout(1500)
  await shot(page, 'reminders-this-week')
  if (!(await reminders.count())) await page.getByRole('button', { name: 'Next week' }).click()
  await expect(reminders.first()).toBeVisible({ timeout: 10_000 })
  await expect(reminders.first()).toContainText('Maria: PayPal reminder')
  await page.waitForTimeout(1500)
  await shot(page, 'reminders-planned')

  await page.getByRole('tab', { name: 'Today' }).click()
  await page.getByRole('link', { name: /^Sent 282.42 to Maria/ }).click()
  await sheet.getByRole('button', { name: 'Stop PayPal reminders' }).click()
  await expect(sheet.getByText('PayPal reminders off')).toBeVisible({ timeout: 20_000 })
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator(`[data-reminder-of="${invoiceId}"]`)).toHaveCount(0)
})
