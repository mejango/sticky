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
