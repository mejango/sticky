import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import type { CollectorSource } from '@/lib/sticky-collector'
import { stickyInfo } from '../home-fixtures'

const mocks = vi.hoisted(() => ({ deployment: vi.fn(), discover: vi.fn(), recipe: vi.fn(), percent: vi.fn(), project: vi.fn() }))
vi.mock('@/lib/sticky-collector', () => ({ stickyCollector: mocks, reservedSplitPercent: mocks.percent }))
vi.mock('@/hooks/useStickyProject', () => ({ useStickyProject: mocks.project }))
vi.mock('@/components/project/flows/FundFlow', () => ({ FundFlow: () => null }))
vi.mock('@/components/project/flows/ReceiverFlow', () => ({ ReceiverFlow: () => null }))
vi.mock('@/components/project/flows/CollectorFlow', () => ({
  CollectorFlow: ({ source }: { source: CollectorSource }) => <div data-collector-source={String(source.allocation.sourceProjectId)} />,
}))
vi.mock('@/components/project/flows/BridgeFlow', () => ({
  BridgeFlow: ({ sourceChainId, delivery }: { sourceChainId: number; delivery: { groupId: bigint } }) => <div data-delivery-source={sourceChainId} data-delivery-group={String(delivery.groupId)} />,
}))
import { ReservedSplitRecipe } from '@/components/project/ReservedSplitRecipe'
import { SendAirdropsCard } from '@/components/project/SendAirdropsCard'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const info = stickyInfo(8453, 9n)
const source = {
  allocation: { deployment: { address: address(1), sourceChainId: 8453, destinationChainId: 8453 }, sourceProjectId: 3n, stickyToken: info.stToken, groupId: 0n },
  verified: { receiver: address(2), sourceToken: address(3), rewardToken: address(4), destinationProjectId: 3n },
} as CollectorSource
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.resetAllMocks()
  mocks.deployment.mockReturnValue(source.allocation.deployment)
  mocks.discover.mockResolvedValue([source])
  mocks.percent.mockReturnValue(263157895)
  mocks.recipe.mockReturnValue({ hook: address(1), beneficiary: info.stToken, projectId: 0n, percent: 263157895 })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const render = (pool = info) => act(async () => root.render(<ReservedSplitRecipe info={pool} onFunded={vi.fn()} />))
function field(label: string) {
  const found = [...container.querySelectorAll('label')].find(item => item.textContent === label)
  if (!found) throw new Error(`Missing ${label}`)
  return document.getElementById(found.htmlFor) as HTMLInputElement | HTMLSelectElement
}
async function fill(label: string, value: string) {
  const control = field(label)
  await act(async () => {
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(button => button.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const click = (text: string) => act(async () => button(text).click())
const recipe = () => container.querySelector('[data-reserved-split-recipe]')

describe('reserved-token split recipe', () => {
  it.each([
    ['home chain', { ...info, chainId: 1 }],
    ['share token', { ...info, stToken: address(99) }],
    ['project', { ...info, projectId: 10n }],
  ])('discards retained and late verification when the %s changes', async (_name, nextPool) => {
    await render()
    await fill('Source project ID or token address', '3')
    await click('Check route')
    await fill('Percentage of reserved tokens', '26.3157895')
    expect(recipe()).not.toBeNull()
    await fill('Source chain', '10')
    await click('Check prior deliveries')
    expect(container.querySelector('[data-delivery-source]')).not.toBeNull()
    await click('Check route')
    expect(recipe()).not.toBeNull()
    await render(nextPool)
    expect(recipe()).toBeNull()
    expect(container.querySelector('[data-collector-source]')).toBeNull()
    expect(container.querySelector('[data-delivery-source]')).toBeNull()

    await render()
    const request = Promise.withResolvers<CollectorSource[]>()
    mocks.discover.mockReturnValue(request.promise)
    await fill('Source project ID or token address', '3')
    await click('Check route')
    await render(nextPool)
    await act(async () => request.resolve([source]))
    expect(recipe()).toBeNull()
    expect(container.querySelector('[data-collector-source]')).toBeNull()
    expect(field('Source project ID or token address').value).toBe('')
  })
  it('does not offer either split recipe from an unverified cached pool', async () => {
    mocks.project.mockReturnValue({ info, verified: false })
    const card = () => act(async () => root.render(<SendAirdropsCard chainId={info.chainId} projectId={Number(info.projectId)} onFunded={vi.fn()} />))
    await card()
    expect(container.querySelector('[data-split-recipe]')).toBeNull()
    expect(container.textContent).not.toContain('Reserved-token rewards')
    mocks.project.mockReturnValue({ info, verified: true })
    await card()
    expect(container.querySelector('[data-split-recipe]')).not.toBeNull()
    expect(container.textContent).toContain('Reserved-token rewards')
  })
  it('shows no copyable collector recipe when deployment records are empty', async () => {
    mocks.deployment.mockReturnValue(undefined)
    await render()
    await fill('Source project ID or token address', '3')
    expect(container.textContent).toContain('No verified collector deployment is configured from Base to Base')
    expect(button('Check route').disabled).toBe(true)
    expect(recipe()).toBeNull()
    expect(container.querySelector('[data-collector-source]')).toBeNull()
    expect(mocks.discover).not.toHaveBeenCalled()
  })
  it('shows SDK split values only after live verification and an explicit reserved percentage', async () => {
    const request = Promise.withResolvers<CollectorSource[]>()
    mocks.discover.mockReturnValue(request.promise)
    await render()
    await fill('Source project ID or token address', '3')
    await click('Check route')
    expect(button('Checking route…').disabled).toBe(true)
    expect(recipe()).toBeNull()
    await act(async () => request.resolve([source]))
    expect(mocks.discover).toHaveBeenCalledWith({ sourceChainId: 8453, homeChainId: 8453, sourceProject: '3', stickyToken: info.stToken, groupId: 0n })
    expect(recipe()).toBeNull()
    expect(container.querySelector('[data-collector-source]')?.getAttribute('data-collector-source')).toBe('3')
    await fill('Percentage of reserved tokens', '26.3157895')
    expect(mocks.percent).toHaveBeenCalledWith('26.3157895')
    expect(mocks.recipe).toHaveBeenCalledWith(source, 263157895)
    expect(recipe()?.textContent).toContain(address(1))
    expect(recipe()?.textContent).toContain(info.stToken)
    expect(recipe()?.textContent).toContain('26.3157895%')
    expect(container.textContent).toContain('not total issuance')
  })
  it('does not publish stale evidence after source, group or chain changes', async () => {
    const request = Promise.withResolvers<CollectorSource[]>()
    mocks.discover.mockReturnValue(request.promise)
    await render()
    await fill('Source project ID or token address', '3')
    await click('Check route')
    await fill('Source project ID or token address', '4')
    await act(async () => request.resolve([source]))
    expect(container.querySelector('[data-collector-source]')).toBeNull()
    expect(recipe()).toBeNull()
    mocks.discover.mockResolvedValue([source])
    await click('Check route')
    await fill('Percentage of reserved tokens', '26.3157895')
    expect(recipe()).not.toBeNull()
    await fill('Minimum stake age (weeks)', '4')
    expect(recipe()).toBeNull()
    await click('Check route')
    await fill('Source chain', '10')
    expect(recipe()).toBeNull()
    expect(container.querySelector('[data-collector-source]')).toBeNull()
  })
  it('keeps prior-delivery recovery available when new route qualification refuses', async () => {
    mocks.discover.mockRejectedValue(new Error('Source route retired'))
    await render()
    await fill('Source chain', '10')
    await fill('Source project ID or token address', '3')
    await click('Check route')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Source route retired')
    expect(recipe()).toBeNull()
    await click('Check prior deliveries')
    expect(container.querySelector('[data-delivery-source]')?.getAttribute('data-delivery-source')).toBe('10')
    expect(container.querySelector('[data-delivery-group]')?.getAttribute('data-delivery-group')).toBe('0')
  })
  it('hides invalid groups and percentages without substituting everyone or rounding', async () => {
    await render()
    await fill('Source project ID or token address', '3')
    await fill('Maximum stake age (weeks)', '8')
    expect(button('Check route').disabled).toBe(true)
    expect(mocks.discover).not.toHaveBeenCalled()
    await fill('Minimum stake age (weeks)', '4')
    await click('Check route')
    mocks.percent.mockImplementation(() => { throw new Error('Too much precision') })
    await fill('Percentage of reserved tokens', '26.31578955')
    expect(recipe()).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too much precision')
    expect(mocks.recipe).not.toHaveBeenCalled()
  })
  it('explains that source credits remain queued until the ERC-20 exists', async () => {
    mocks.discover.mockResolvedValue([{ ...source, verified: { ...source.verified, sourceToken: zeroAddress } }])
    await render()
    await fill('Source project ID or token address', '3')
    await click('Check route')
    expect(container.textContent).toContain('Project credits can queue here. Delivery waits until the source project deploys its ERC-20.')
  })
})
