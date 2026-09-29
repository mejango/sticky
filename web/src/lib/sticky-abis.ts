import { erc20Abi, parseAbi } from 'viem'

export {
  stickyAutoStickAbi,
  stickyDeployerAbi,
  stickyDistributorAbi,
  stickyHookAbi,
  stickyRewardReceiverFactoryAbi,
} from '@bananapus/nana-sdk-core'

// The lists below hold the functions Sticky calls and no more. The SDK's jb*Abi exports carry each
// whole contract, and a test holds every list here to them.

/** A Sticky token, the ERC-20 a stick mints, with 18 decimals. `SOULBOUND` says whether it can be
 * transferred, and `getPastVotes` reads a holder's delegated voting power at a past timepoint. */
export const stickyTokenAbi = [
  ...erc20Abi,
  ...parseAbi([
    'function SOULBOUND() view returns (bool)',
    'function getPastVotes(address account, uint256 timepoint) view returns (uint256)',
  ]),
] as const

/** JBMultiTerminal's previews and fee reads, plus the store it books balances in. */
export const terminalAbi = parseAbi([
  'struct JBRuleset { uint48 cycleNumber; uint48 id; uint48 basedOnId; uint48 start; uint32 duration; uint112 weight; uint32 weightCutPercent; address approvalHook; uint256 metadata; }',
  'struct JBPayHookSpecification { address hook; bool noop; uint256 amount; bytes metadata; }',
  'struct JBCashOutHookSpecification { address hook; bool noop; uint256 amount; bytes metadata; }',
  'function STORE() view returns (address)',
  'function FEELESS_ADDRESSES() view returns (address)',
  'function feeFreeSurplusOf(uint256 projectId, address token) view returns (uint256)',
  'function previewPayFor(uint256 projectId, address token, uint256 amount, address beneficiary, bytes metadata) view returns (JBRuleset ruleset, uint256 beneficiaryTokenCount, uint256 reservedTokenCount, JBPayHookSpecification[] hookSpecifications)',
  'function previewCashOutFrom(address holder, uint256 projectId, uint256 cashOutCount, address tokenToReclaim, address beneficiary, bytes metadata) view returns (JBRuleset ruleset, uint256 reclaimAmount, uint256 cashOutTaxRate, JBCashOutHookSpecification[] hookSpecifications)',
])

/** The registry the terminal's `FEELESS_ADDRESSES()` names. */
export const feelessAddressesAbi = parseAbi([
  'function isFeelessFor(address addr, uint256 projectId, address caller) view returns (bool)',
])

/** JBTerminalStore, where the terminal's balance for a project and token lives. */
export const terminalStoreAbi = parseAbi([
  'function balanceOf(address terminal, uint256 projectId, address token) view returns (uint256)',
])

/** JBProjects, the project NFTs. */
export const projectsAbi = parseAbi([
  'function count() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function creationFee() view returns (uint256)',
])

/** JBTokens, which maps a project to its ERC-20 and back. */
export const tokensAbi = parseAbi([
  'function tokenOf(uint256 projectId) view returns (address)',
  'function projectIdOf(address token) view returns (uint256)',
])

/** JBController's project uri. A Sticky launch stores its launch id there. */
export const controllerAbi = parseAbi(['function uriOf(uint256 projectId) view returns (string)'])
