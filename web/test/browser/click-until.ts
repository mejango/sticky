import type { Locator } from '@playwright/test'

/** How many times the link is clicked at most. */
const CLICKS = 4
/** How long a click has to start what it starts before the link is clicked again. */
const SETTLE_MS = 2_000
/** How long the last click has to start it. */
const FINAL_MS = 15_000
/** How long one click may take to be made: the link has to be there, shown and still. */
const CLICK_MS = 5_000

/**
 * Clicks `target` until `reached` settles, and says whether it did. A click that reaches a frame that has just opened on
 * another origin, before the frame takes input, is dropped without a navigation, so a click that has started nothing 2 s
 * later is made again, up to four times, unless the link is gone because the frame has left. The last click has 15 s
 * more. Nothing waits without a bound: a click that cannot be made rejects after 5 s, and `reached` is waited on only
 * for the times above.
 */
export async function clickUntil(target: Locator, reached: Promise<unknown>): Promise<boolean> {
  const within = (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>(resolve => {
      timer = setTimeout(resolve, milliseconds, false)
    })
    return Promise.race([reached.then(() => true), late]).finally(() => clearTimeout(timer))
  }
  for (let click = 1; click <= CLICKS; click += 1) {
    await target.click({ timeout: CLICK_MS })
    if ((await within(SETTLE_MS)) || (await target.count()) === 0) break
  }
  return within(FINAL_MS)
}
