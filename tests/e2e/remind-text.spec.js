// The reminder text survives a page redraw after switching tabs.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test('the reminder card keeps edited text when the page redraws', async ({ page }) => {
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Remind Dave about his invoice.')
  await page.getByRole('button', { name: 'Send text' }).click()
  const reminder = page.locator('.remind-text')
  await reminder.waitFor({ timeout: 40_000 })
  await expect(page.getByText('PayPal sends its standard reminder.', { exact: true })).toBeVisible()
  await expect(reminder).toHaveAttribute('aria-label', 'Your own message, to copy into a text or email')
  await reminder.fill('Hi Dave. Friendly nudge on the leak repair.')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.getByRole('tab', { name: 'Today' }).click()
  await expect(page.locator('.remind-text')).toHaveValue('Hi Dave. Friendly nudge on the leak repair.')
})

test('copying a reminder message uses the clipboard and sends no request', async ({ page, context }) => {
  await page.goto('/?calendar=fallback')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill('Remind Dave about his invoice.')
  await page.getByRole('button', { name: 'Send text' }).click()
  const reminder = page.getByRole('textbox', { name: 'Your own message, to copy into a text or email' })
  await reminder.waitFor({ timeout: 40_000 })
  await reminder.fill('Hi Dave. Friendly nudge.')
  const requests = []
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request.url())
  })
  const copy = page.getByRole('button', { name: 'Copy message' })
  await copy.click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Hi Dave. Friendly nudge.')
  expect(requests).toEqual([])
})
