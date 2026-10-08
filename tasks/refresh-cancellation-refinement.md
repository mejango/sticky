# Confirmed-write refresh cancellation

## Plan refinement

- **Objective:** Prevent an initial read started before a confirmed Sticky write from restoring stale results as fresh after its scoped invalidation.
- **System fit:** Existing Sticky refresh owners choose affected query keys; TanStack Query owns cancellation and invalidation. Receipt proof and wallet authority remain unchanged.
- **Reuse and simplicity:** Apply the proven sibling cancel-then-invalidate sequence inside existing scheduled and detached refresh owners. Keep the existing schedules, exact scopes and detached no-refetch behavior; add no new cache layer.
- **Evidence and unknowns:** The four-client census found both owners invalidate without canceling an initial pending fetch, which TanStack may otherwise retain. A real QueryClient regression will prove the race and unrelated-read isolation.
- **Verification:** Run the focused refresh suite including delayed pre-confirmation results, detached no-refetch behavior and existing precise-scope/schedule assertions, then affected flow tests with the app owner's final gates.
- **Resource budget:** Root owns only sticky-refresh.ts and its existing test file. No dependency mutations or concurrent full suites; reuse the installed qualified SDK and native test runner.

- [x] Demonstrate old read cannot overwrite confirmed state and unrelated reads continue.
- [x] Cancel each selected filter before invalidating; retain the existing timing and scope.
- [x] Run focused tests and hand ownership back to the Sticky integrator.

## Review

The two real QueryClient regressions fail before the change (`fetching` instead of `idle`) and pass after it. All 26 focused library and actual-hook query-scope checks pass. Scheduled refresh still uses 0/4/12 seconds; detached completion marks only its prior chain/display scope stale with no automatic refetch. Unrelated in-flight reads continue.
