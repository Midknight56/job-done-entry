// The invoice card reads in three steps: 1 Job, 2 Visit, 3 Payment. Send waits for the visit and says why.
import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

const MARIA = 'Kitchen tap for Maria at 14 Elm, hour and a half, the tap was 89.'

async function draft(page, size) {
  if (size) await page.setViewportSize(size)
  await page.goto('/?calendar=fallback')
  await newDemo(page, -new Date().getTimezoneOffset())
  await page.reload()
  await page.getByRole('textbox', { name: 'Describe the job' }).fill(MARIA)
  await page.getByRole('button', { name: 'Send text' }).click()
  const card = page.locator('article.card').filter({ has: page.getByRole('button', { name: /^Send \d/ }) })
  await expect(card).toBeVisible({ timeout: 40_000 })
  return card
}

test('an existing visit: three steps, a visit summary, and Send waits with a reason', async ({ page }) => {
  const card = await draft(page)
  await expect(card.locator('h3')).toHaveText(['1 Job', '2 Visit', '3 Payment'])
  const visit = card.locator('.step-visit')
  await expect(visit.locator('select[name="jobId"]')).not.toHaveValue('')
  await expect(visit.locator('.visit-summary')).toContainText('Maria Lopez, 14 Elm Street.')
  await expect(visit.locator('.visit-summary')).toContainText(/to .*1 h 30 min/)
  await expect(visit.locator('input[name="start"]')).toBeHidden()
  await expect(visit.locator('input[name="end"]')).toBeHidden()
  const send = card.getByRole('button', { name: /^Send \d/ })
  await expect(card.locator('.send-why')).toHaveText('Confirm the visit to send.')
  await expect(send).toBeDisabled()
  await visit.getByRole('button', { name: 'Confirm visit', exact: true }).click()
  await expect(send).toBeEnabled({ timeout: 20_000 })
  await expect(card.locator('.send-why')).toHaveCount(0)
  await expect(visit).toContainText('Visit confirmed.')
  await expect(visit).toContainText(/1 h 30 min/)
})

test('a new completed visit shows its times; a future end is refused and a past one works', async ({ page }) => {
  const card = await draft(page)
  const visit = card.locator('.step-visit')
  await visit.locator('select[name="jobId"]').selectOption('')
  await expect(visit.locator('input[name="start"]')).toBeVisible()
  await expect(visit.locator('input[name="end"]')).toBeVisible()
  const local = (ms) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await visit.locator('input[name="start"]').fill(local(Date.now() + 2 * 3600000))
  await visit.locator('input[name="end"]').fill(local(Date.now() + 3 * 3600000))
  await visit.getByRole('button', { name: 'Confirm visit', exact: true }).click()
  await expect(page.getByText('Enter the completed visit start and end. Use at most eight hours.')).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('button', { name: /^Send \d/ })).toBeDisabled()
  await visit.locator('input[name="start"]').fill(local(Date.now() - 3 * 3600000))
  await visit.locator('input[name="end"]').fill(local(Date.now() - 2 * 3600000))
  await visit.getByRole('button', { name: 'Confirm visit', exact: true }).click()
  await expect(card.getByRole('button', { name: /^Send \d/ })).toBeEnabled({ timeout: 20_000 })
})

test('switching back to an existing visit hides the times and keeps the choice through a poll', async ({ page }) => {
  const card = await draft(page)
  const visit = card.locator('.step-visit')
  const select = visit.locator('select[name="jobId"]')
  const existing = await select.inputValue()
  await select.selectOption('')
  await expect(visit.locator('input[name="start"]')).toBeVisible()
  await select.selectOption(existing)
  await expect(visit.locator('input[name="start"]')).toBeHidden()
  await page.waitForTimeout(4_000) // the page polls every 3 s and redraws the card
  await expect(card.locator('.step-visit select[name="jobId"]')).toHaveValue(existing)
  await expect(card.locator('.step-visit input[name="start"]')).toBeHidden()
})

/** Scrolls the card's scrolling parent to its end, where the last step and Send sit. */
async function toBottom(card) {
  await card.evaluate((el) => {
    let box = el.parentElement
    while (box && box.scrollHeight <= box.clientHeight + 1) box = box.parentElement
    if (box) box.scrollTop = box.scrollHeight
  })
  await card.page().waitForTimeout(300)
}

for (const size of [{ width: 360, height: 640 }, { width: 390, height: 844 }]) {
  test(`the steps fit a ${size.width} x ${size.height} phone`, async ({ page }) => {
    const card = await draft(page, size)
    const fits = () => card.evaluate((el) => {
      const wide = [...el.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
      return { wide: wide.map((child) => child.className || child.tagName), scroll: document.documentElement.scrollWidth > window.innerWidth + 1 }
    })
    expect(await fits()).toEqual({ wide: [], scroll: false })
    await toBottom(card)
    await expect(card.locator('.send-why')).toBeInViewport()
    await page.screenshot({ path: `test-results/invoice-review-before-confirm-${size.width}x${size.height}.png` })
    await card.getByRole('button', { name: 'Confirm visit', exact: true }).click()
    await expect(card.getByRole('button', { name: /^Send \d/ })).toBeEnabled({ timeout: 20_000 })
    expect(await fits()).toEqual({ wide: [], scroll: false })
    await toBottom(card)
    await expect(card.locator('.pay-options')).toBeInViewport()
    await page.screenshot({ path: `test-results/invoice-ready-to-send-${size.width}x${size.height}.png` })
  })
}
