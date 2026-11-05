// Drags on the Bryntum Calendar, shared by its spec and the film capture. The page must show the Calendar tab.

/** Moves the mouse from one point to another in small steps, so Bryntum sees a drag. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 12; step += 1) {
    const progress = step / 12
    await page.mouse.move(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress)
    await page.waitForTimeout(25)
  }
  await page.mouse.up()
}

/** The top middle of a job's block, a little inside it. */
async function grip(page, jobId) {
  const box = await page.locator(`.b-cal-event-wrap:has([data-job-id="${jobId}"])`).first().boundingBox()
  if (!box) throw new Error(`Job ${jobId} is not on screen`)
  return { x: box.x + box.width / 2, y: box.y + Math.min(12, box.height / 2) }
}

/** Centers both ends of a drag inside the time grid, away from its scrolling edges. */
async function centerDrag(page, jobId, ontoId = null) {
  await page.locator(`.b-cal-event-wrap:has([data-job-id="${jobId}"])`).first().evaluate((element, ontoId) => {
    const scroller = element.closest('.b-day-view-day-content')
    if (!scroller) throw new Error('The job has no time grid')
    const box = element.getBoundingClientRect()
    const fromY = box.y + Math.min(12, box.height / 2)
    const target = ontoId && scroller.querySelector(`.b-cal-event-wrap:has([data-job-id="${ontoId}"])`)
    const targetBox = target && target.getBoundingClientRect()
    const toY = targetBox ? targetBox.y + Math.min(12, targetBox.height / 2) : fromY - box.height
    const view = scroller.getBoundingClientRect()
    scroller.scrollTop += (fromY + toY) / 2 - (view.y + scroller.clientHeight / 2)
  }, ontoId)
}

/** Drags a job up in its own day column by its own height, to the free slot before it. */
export async function dragJobUp(page, jobId) {
  await centerDrag(page, jobId)
  const box = await page.locator(`.b-cal-event-wrap:has([data-job-id="${jobId}"])`).first().boundingBox()
  const from = await grip(page, jobId)
  await drag(page, from, { x: from.x, y: from.y - (box?.height || 0) })
}

/** Drags one job onto the top of another. */
export async function dragJobOnto(page, jobId, ontoId) {
  await centerDrag(page, jobId, ontoId)
  await drag(page, await grip(page, jobId), await grip(page, ontoId))
}
