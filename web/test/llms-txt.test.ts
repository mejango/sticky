// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { displayChainSlug } from '@/lib/chainDisplay'
import { SUPPORTED_CHAINS } from '@/lib/chains'

/** The file as a site at `origin` serves it. The route reads its origin when it is asked, as the site's metadata does. */
async function llms(origin: string | null = 'https://sticky.example') {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin ?? undefined)
  const { GET, revalidate } = await import('@/app/llms.txt/route')
  const response = GET()
  return { response, revalidate, text: await response.text() }
}

/** One `## ` section of the file, from its heading to the next. */
function section(text: string, heading: string) {
  const found = text.split(/^## /m).find(part => part.startsWith(`${heading}\n`))
  expect(found, `a "${heading}" section`).toBeDefined()
  return found!
}

describe('GET /llms.txt', () => {
  it('serves plain text, and regenerates it every hour', async () => {
    const { response, revalidate } = await llms()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(revalidate).toBe(3600)
  })

  it('opens with the name, what Sticky does, and how to read the site as an agent', async () => {
    const { text } = await llms()
    expect(text.startsWith('# Sticky\n\n> Sticky issues shares of a Juicebox project')).toBe(true)
    expect(section(text, 'How to read this site as an agent')).toContain('no JSON API')
  })

  it('lists the paths of the pages, and no hash route', async () => {
    const { text } = await llms()
    const routes = section(text, 'Routes')
    for (const route of ['`/`', '`/?network=testnet`', '`/<chain>:<projectId>`', '`/@<handle>`', '`/account/<address>`']) {
      expect(routes).toContain(route)
    }
    // A project's tabs are the hash of its path. Nothing in the file is a route in the old client's `#/` form.
    for (const tab of ['#overview', '#tokens', '#airdrops', '#latest']) expect(routes).toContain(`\`${tab}\``)
    expect(text).not.toContain('#/')
  })

  it('names the slug of every chain the site routes on', async () => {
    const routes = section((await llms()).text, 'Routes')
    for (const chain of SUPPORTED_CHAINS) {
      expect(routes, `the slug of chain ${chain.id}`).toContain(`\`${displayChainSlug(chain.id)}\``)
    }
  })

  it('says where the site is, from the origin it is served on', async () => {
    const dev = (await llms('https://dev.sticky.example/')).text
    expect(dev).toContain('a path on https://dev.sticky.example.')
    expect(dev).not.toContain('sticky.center')
    expect((await llms(null)).text).toContain('a path on https://sticky.center.')
  })

  it('keeps the vocabulary and the reading advice the old client published', async () => {
    const { text } = await llms()
    const vocabulary = section(text, 'Vocabulary')
    for (const term of ['**Stick / unstick**', '**Sticky shares**', '**Streak**', '**Bonus / cash out tax**', '**Unowned backing**', '**Rewards**']) {
      expect(vocabulary).toContain(term)
    }
    expect(text).toContain("Use the terminal's previewPayFor with the real payer and beneficiary for issuance")
    expect(text).toContain('Read holder tranches through the bounded overload (at most 256 entries;')
  })

  it('links the contracts, this client and the protocol', async () => {
    const source = section((await llms()).text, 'Source')
    expect(source).toContain('- Hook and distributor contracts: https://github.com/mejango/sticky\n')
    expect(source).toContain('- This client: https://github.com/mejango/sticky/tree/main/web\n')
    expect(source).toContain('- Protocol contracts: https://github.com/Bananapus/version-6')
  })

  it('follows the copy rules: no middle dot, no emoji', async () => {
    expect((await llms()).text).not.toMatch(/·|\p{Extended_Pictographic}/u)
  })
})
