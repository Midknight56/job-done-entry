import { test, expect } from '@playwright/test'
import { newDemo } from './demo.js'

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' })

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
  test.describe(`phone ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: true })

    test.beforeEach(async ({ page }) => {
      await page.goto('/?calendar=bryntum')
      await newDemo(page, 0)
      await page.reload()
      await page.getByRole('tab', { name: 'Calendar' }).click()
      await expect(page.getByRole('grid', { name: 'Day', exact: true })).toBeVisible()
      await expect(page.locator('[data-job-id="j2"]')).toContainText('Maria')
    })

    test('toolbar controls fit without clipping or overlap', async ({ page }) => {
      const toolbar = page.locator('.b-calendar .b-top-toolbar').first()
      for (const ref of ['todayButton', 'prevButton', 'nextButton']) {
        await expect(toolbar.locator(`[data-ref="${ref}"]`)).toBeVisible()
      }
      for (const name of ['Day', 'Week', 'Agenda']) {
        await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible()
      }
      const faults = await toolbar.evaluate((bar) => {
        const bounds = bar.getBoundingClientRect()
        const items = [...bar.querySelectorAll('button, .b-label, .b-button-label, .b-calendar-view-desc, .b-calendar-view-desc-text')]
          .filter((item) => item.checkVisibility() && item.getBoundingClientRect().width > 0)
        const faults = []
        for (const item of items) {
          const box = item.getBoundingClientRect()
          const name = item.textContent.trim() || item.getAttribute('aria-label') || item.className
          if (item.scrollWidth > item.clientWidth + 1) faults.push(`${name} is clipped`)
          if (box.left < bounds.left - 1 || box.right > bounds.right + 1) faults.push(`${name} is outside toolbar`)
          for (const other of items) {
            if (item === other || item.contains(other) || other.contains(item)) continue
            const next = other.getBoundingClientRect()
            if (Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 &&
                Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1) faults.push(`${name} overlaps ${other.textContent.trim()}`)
          }
        }
        const centers = items.filter((item) => item.tagName === 'BUTTON').map((item) => {
          const box = item.getBoundingClientRect()
          return box.top + box.height / 2
        })
        if (Math.max(...centers) - Math.min(...centers) > 1) faults.push('buttons span several rows')
        return faults
      })
      expect(faults).toEqual([])
      await page.screenshot({ path: `test-results/phone-${viewport.width}-toolbar.png` })
    })

    for (const minutes of [90, 60]) test(`Maria has separate readable lines in a ${minutes} minute job`, async ({ page }) => {
      if (minutes === 60) {
        await page.route('**/api/state', async (route) => {
          const response = await route.fetch()
          const state = await response.json()
          const job = state.ws.jobs.find((job) => job.id === 'j2')
          job.end = new Date(Date.parse(job.start) + 60 * 60_000).toISOString()
          await route.fulfill({ response, json: state })
        })
        await page.reload()
        await page.getByRole('tab', { name: 'Calendar' }).click()
        await expect(page.locator('[data-job-id="j2"]')).toContainText('Maria')
      }
      const block = page.locator('.b-cal-event-wrap').filter({ has: page.locator('[data-job-id="j2"]') })
      const faults = await block.evaluate((block) => {
        const bounds = block.getBoundingClientRect()
        const lines = [...block.querySelectorAll('[data-job-id] strong, .jd-summary, .jd-hold')]
        const faults = []
        for (const [index, line] of lines.entries()) {
          const box = line.getBoundingClientRect()
          if (box.height < 1 || line.scrollHeight > line.clientHeight + 1) faults.push(`${line.textContent} is clipped`)
          if (box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom) faults.push(`${line.textContent} is outside job`)
          const parent = line.closest('.b-cal-event-desc').getBoundingClientRect()
          if (box.bottom > parent.bottom + 1) faults.push(`${line.textContent} is clipped by its container`)
          if (index && lines[index - 1].getBoundingClientRect().bottom > box.top + 1) faults.push(`${line.textContent} overlaps previous line`)
        }
        return { count: lines.length, faults }
      })
      expect(faults.count).toBe(3)
      expect(faults.faults).toEqual([])
      await block.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `test-results/phone-${viewport.width}-day-${minutes}.png` })
    })

    test('a tap brings Job details into the viewport and toggles closed', async ({ page }) => {
      const job = page.locator('[data-job-id="j2"]')
      const block = page.locator('.b-cal-event-wrap').filter({ has: job })
      await block.evaluate((element) => element.scrollIntoView({ block: 'center' }))
      await page.locator('.phone-content').evaluate((element) => { element.scrollTop = 0 })
      const box = await block.boundingBox()
      await page.touchscreen.tap(box.x + 10, box.y + 3)
      const details = page.getByRole('region', { name: 'Job details', exact: true })
      await expect(details).toContainText('Maria Lopez')
      await expect(details).toBeInViewport()
      await page.screenshot({ path: `test-results/phone-${viewport.width}-details.png` })
      await job.click()
      await expect(details).toBeHidden()
      await job.click()
      await expect(details).toBeInViewport()
      await details.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(details).toBeHidden()
    })
  })
}

test('phone calendar opens a day, shows tap details and a held deposit', async ({ page }) => {
  await page.goto('/?calendar=bryntum')
  await newDemo(page, 0)
  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.getByRole('grid', { name: 'Day', exact: true })).toBeVisible()
  const state = await (await page.request.get('/api/state')).json()
  const job = state.ws.jobs.find((job) => job.state === 'booked')
  const person = state.ws.customers.find((person) => person.id === job.customerId)
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const week = page.getByRole('grid', { name: 'Week', exact: true })
  await expect(week).toBeVisible()
  const event = week.locator(`.b-cal-event-wrap[data-event-id="${job.id}"]`)
  await event.click()
  const details = page.locator('.job-details')
  await expect(details).toContainText(person.name)
  await expect(details).toContainText('Booked')
  await expect(details).not.toContainText('Deposit')
  await event.click()
  await expect(details).toBeHidden()
  await event.click()
  await details.getByRole('button', { name: 'Close' }).click()
  await expect(details).toBeHidden()
  const booking = await (await page.request.post('/api/agent', { data: { text: 'Book the bathroom tap for Maria next week.' } })).json()
  const sent = await page.request.post(`/api/drafts/${booking.proposal.draftId}/send`)
  expect(sent.status()).toBe(200)
  await page.reload()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(week).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next week' })).toBeVisible()
  if (!await week.locator(`[data-job-id="${booking.proposal.jobId}"]`).count()) await page.getByRole('button', { name: 'Next week' }).click()
  await expect(week.locator(`[data-job-id="${booking.proposal.jobId}"]`)).toContainText('Held, deposit 50.00')
  await page.goto('/?calendar=fallback')
  await page.getByRole('tab', { name: 'Calendar' }).click()
  const held = page.locator(`[data-job-id="${booking.proposal.jobId}"]:visible`)
  search: for (let week = 0; week < 2; week++) {
    if (week) await page.getByRole('button', { name: 'Next week' }).click()
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      await page.getByRole('button', { name: day, exact: true }).click()
      if (await held.count()) break search
    }
  }
  await expect(held).toContainText('Held, deposit 50.00')
  await held.click()
  await expect(details).toContainText('Maria Lopez')
  await expect(details).toContainText('Deposit 50.00')
  await held.click()
  await expect(details).toBeHidden()
})
