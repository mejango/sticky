import { jbCenterAppOrigin } from '@/lib/jbcenter-config'

/**
 * llmstxt.org index: the paths an agent needs to name a page on this site, and the words the pages use. It is the old
 * client's file with its hash routes replaced by their paths.
 */
const llmsTxt = (origin: string) => `# Sticky

> Sticky issues shares of a Juicebox project's token backing and tracks how long a
> holder keeps a positive share balance. Deposits are priced against current backing;
> cash outs follow the project's permanent tax setting and applicable terminal fees.
> The holder's clock resets only when their share balance reaches zero. There is no
> time lock; a 100% cash out tax returns no underlying tokens, even on a full exit.

## How to read this site as an agent

Every route below is a path on ${origin}. Pages render in the browser, so fetching a
route returns a shell without the project's numbers. The numbers come from JSON-RPC reads the
browser makes against the project's chain, and from Bendystraw, an index of chain records.
There is no JSON API.

## Routes

- \`/\` — sticky tokens ranked by amount stuck. \`/?network=testnet\` lists the tokens on testnets.
- \`/<chain>:<projectId>\` — one sticky token, e.g. \`/base:23\`: what is stuck, who is streaking, the
  bonus left behind by unsticking. Chain slugs: \`eth\`, \`op\`, \`base\`, \`arb\`, plus \`sep\`, \`opsep\`,
  \`basesep\`, \`arbsep\` for testnets. A tab is a hash fragment: \`#overview\` (the default), \`#tokens\`,
  \`#airdrops\` and \`#latest\`.
- \`/@<handle>\` — the same sticky token by the project's verified ENS handle. The handle
  resolves only when the JBProjectHandles registry confirms the project's owner claimed
  it, so it names exactly one project.
- \`/account/<address>\` — one account's streaks across sticky tokens. Not indexed. Add
  \`?network=testnet\` for testnets.

## Vocabulary

- **Stick / unstick** — deposit underlying tokens for Sticky shares, or burn shares to redeem backing.
  Unsticking consumes newest tranches first; a partial tranche keeps its timestamp.
- **Sticky shares** — 18-decimal balances, distinct from underlying-token amounts. Existing-supply
  issuance uses floor(deposit × share supply / share-owned backing), with a conservative one-basis-point
  share-rounding guard. The immutable per-project accounting feed provides the exact denominator.
- **Streak** — how long an account has held a non-zero stuck balance. It resets only at zero.
- **Bonus / cash out tax** — the Juicebox curve can leave backing for remaining shares. Its effect
  depends on the portion of supply redeemed; zero tax does not waive other applicable terminal fees.
- **Unowned backing** — funds present when no shares exist are permanently excluded when a new
  deposit establishes supply. New entrants cannot redeem these funds.
- **Rewards** — each funding names its group: everyone at the round's snapshot (group 0), or only
  stake held for a minimum number of weeks when the round started (\`minWeeks * 1000 + maxWeeks\`).
  Stake-age rewards pay only stake still held at claim time; exiting first forfeits them. Auto-stick
  quotes during execution and rejects zero issuance; earlier collection to the holder's wallet can
  leave a keeper with nothing to compound.

Use the terminal's previewPayFor with the real payer and beneficiary for issuance, and a reviewed
nonzero minReturnedTokens for a direct payment. Do not assume fixed one-for-one issuance. A positive
burn, including a voluntary burn without reclaim, or a transfer can emit Unstaked; that event alone
does not establish a payout. Read holder tranches through the bounded overload (at most 256 entries;
the client uses 50), rather than the unbounded whole-array getter.

## Source

- Hook and distributor contracts: https://github.com/mejango/sticky
- This client: https://github.com/mejango/sticky/tree/main/web
- Protocol contracts: https://github.com/Bananapus/version-6
`

export const revalidate = 3600

export function GET() {
  return new Response(llmsTxt(jbCenterAppOrigin()), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
