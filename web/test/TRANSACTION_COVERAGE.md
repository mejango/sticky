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

| User action | Contract function or authorization | Coverage | Test |
| --- | --- | :---: | --- |
| Submit a reviewed direct write | review → chain/account check → simulate → exact simulated write | **P** | `transactions/contract-write.test.ts`, `transactions/use-safe-tx.test.ts`, `transactions/sticky-use-safe-tx.test.tsx`, `transactions/signa-gate.test.tsx` |
| Approve the staked token for a stick | `ERC20.approve` to the project's terminal: a reset to zero first when the allowance is not zero, the exact amount, and nothing when the allowance already covers it | **E** | `lib/sticky-builders.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick | `JBMultiTerminal.pay` for the holder, with the freshly read `previewPayFor` as its minimum | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick for someone else | `JBMultiTerminal.pay` with another beneficiary, sent only after `isGranterOf` or `isTrustedSenderOf` says the sender may | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
