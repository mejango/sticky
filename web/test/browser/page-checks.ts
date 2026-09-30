import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

// What the browser specs ask of a page, at every viewport they visit it at: it stays inside the screen, and its
// accessibility and contrast hold.

export async function expectNoDocumentOverflow(page: Page, surface: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(
    dimensions.scrollWidth,
    `${surface} introduced document-level horizontal overflow`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

export async function expectAxeClean(page: Page, surface: string) {
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const severe = axe.violations.filter(
    violation =>
      violation.id !== 'color-contrast' &&
      (violation.impact === 'serious' || violation.impact === 'critical'),
  )
  expect(
    severe.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map(node => node.target),
    })),
    `${surface} has serious or critical accessibility violations`,
  ).toEqual([])

  const contrastNodes =
    axe.violations.find(violation => violation.id === 'color-contrast')?.nodes ??
    []
  expect(
    contrastNodes.map(node => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
    })),
    `${surface} has color-contrast violations`,
  ).toEqual([])
}
