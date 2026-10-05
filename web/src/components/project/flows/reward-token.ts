import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { parseAddress } from '@/components/project/flows/AddressInput'

/**
 * The reward token a field names, as the old client took it (OLD rewardTokenAddress, app.js:3614): the staked token
 * when the field is blank, JB's native token for "ETH" in any case, and otherwise a whole address that is not the zero
 * address (`parseAddress`). Null for anything else.
 */
export function parseRewardToken(text: string, stakedToken: Address): Address | null {
  const input = text.trim()
  if (input === '') return stakedToken
  if (/^eth$/i.test(input)) return NATIVE_TOKEN
  return parseAddress(input)
}
