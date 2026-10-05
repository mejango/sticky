import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { getAddress, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { parseRewardToken } from '@/components/project/flows/reward-token'

const STAKED = getAddress(`0x${'2'.repeat(40)}`)
const USDC = getAddress(`0x${'6b'.repeat(20)}`)

describe('parseRewardToken', () => {
  it('takes the staked token for a blank field, JB\'s native token for ETH in any case, and a whole address checksummed', () => {
    expect(parseRewardToken('  ', STAKED)).toBe(STAKED)
    expect(parseRewardToken('ETH', STAKED)).toBe(NATIVE_TOKEN)
    expect(parseRewardToken(' eth ', STAKED)).toBe(NATIVE_TOKEN)
    expect(parseRewardToken(USDC.toLowerCase(), STAKED)).toBe(USDC)
  })

  it('takes nothing else: a word, a short address, a wrong checksum or the zero address', () => {
    const miscased = USDC.replace(/[a-f]/, letter => letter.toUpperCase())
    for (const text of ['usdc', USDC.slice(0, 40), miscased, zeroAddress, 'ETH2']) expect(parseRewardToken(text, STAKED)).toBeNull()
  })
})
