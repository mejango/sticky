# Transaction coverage: Sticky

This inventory tracks semantic coverage of wallet-affecting operations. The
contracts and canonical SDK ABIs are authoritative; Bendystraw is display and
discovery data only. `npm run transaction:check` reads this table and
`test/transaction-sites.json`. Every write site names the actions it sends, and
every action here names the tests that cover it.

Legend:

- **E**: exact request or calldata encode/decode assertions
- **S**: canonical selector/ABI-shape assertion only
- **P**: pure planning/state-machine assertions
- **-**: no dedicated regression test yet

Each test file named for an action that a wallet write maps to carries the
action's marker in the `it` or `test` title (`.each` included) of a test that
proves it, for example `wallet-action:stick-for-someone-else` for "Stick for
someone else". A `describe` or `suite` title, and any test under `.skip`,
`.todo`, `.skipIf`, `.runIf`, `.fails` or a bracketed modifier
(`describe['skip']`), does not count. `npm run transaction:check` fails on a
missing marker.

| User action | Contract function or authorization | Coverage | Test |
| --- | --- | :---: | --- |
| Submit a reviewed direct write | reviewed-account check → review → chain/account check → simulate → exact simulated write | **P** | `transactions/contract-write.test.ts`, `transactions/use-safe-tx.test.ts`, `transactions/sticky-use-safe-tx.test.tsx`, `transactions/signa-gate.test.tsx` |
| Approve the staked token for a stick | `ERC20.approve` to the project's terminal: a reset to zero first when the allowance is not zero, the exact amount, and nothing when the allowance already covers it | **E** | `lib/sticky-builders.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick | `JBMultiTerminal.pay` for the holder, with the freshly read `previewPayFor` as its minimum | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick for someone else | `JBMultiTerminal.pay` with another beneficiary, sent only after `isGranterOf` or `isTrustedSenderOf` says the sender may | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Turn off auto-stick | `StickyAutoStick.setConfigFor(projectId, false, minimum, cooldown)` | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts` |
| Take back the auto-stick adapter's trust | `StickyHook.setTrustedSenderFor(projectId, adapter, false)` | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts` |
| Take back the auto-stick adapter's allowance | staked token `approve(adapter, 0)` | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts` |
| Unstick Sticky tokens | `JBMultiTerminal.cashOutTokensOf` with the quote's net as its minimum | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts` |
| Transfer Sticky tokens | Sticky token `transfer` of an 18-decimal amount, refused for a locked token, for the zero address, for the sender's own address and for the Sticky token, hook and terminal, and stopped when the balance has fallen | **E** | `lib/sticky-builders.test.ts`, `components/transfer-flow.test.tsx`, `transactions/sticky-transfer-trust.test.tsx` |
| Trust or untrust a sender | `StickyHook.setTrustedSenderFor`, refused for the zero address, and stopped when the hook already says so | **E** | `lib/sticky-builders.test.ts`, `components/trust-flow.test.tsx`, `transactions/sticky-transfer-trust.test.tsx` |
