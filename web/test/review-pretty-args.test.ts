// The transaction safety check's precise argument decoders. Every decoder must
// interpret real builder output exactly, refuse ambiguity rather than guess,
// and fall back to null (the raw view) on anything it can't fully account for.
import {
  describeJBHookMetadata,
  describePermissionsData,
  describeSafeInitializer,
  describeSafeInnerCall,
  describeSuckerClaim,
  describeSplitGroups,
  type PrettyStep,
} from "@/components/TransactionReviewDialog"
import { safeSetupAbi, safeToL2SetupAbi } from "@/lib/cross-chain-authority"
import { createHookMetadata, hookMetadataId, jbControllerAbi } from "@bananapus/nana-sdk-core";
import {
  build721CashOutMetadata,
  build721PayMetadata,
  buildBuybackCashOutMetadata,
} from "@bananapus/nana-sdk-core/v6";
import { encodeAbiParameters, encodeFunctionData, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

const TARGET = "0x4444444444444444444444444444444444444444";
const HOOK = "0x5555555555555555555555555555555555555555";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

const rowsOf = (steps: PrettyStep[] | null) =>
  (steps ?? []).flatMap((step) => step.rows.map(([label, value]) => `${label}=${value}`));

describe("JB hook metadata decoding", () => {
  it("reads 721 mint instructions from the real builder's bytes", () => {
    const metadata = build721PayMetadata({
      metadataIdTarget: TARGET,
      tierIdsToMint: [4n, 4n, 7n],
      allowOverspending: false,
    });
    const steps = describeJBHookMetadata("pay", metadata)!;
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe("721 shop mint instructions");
    expect(rowsOf(steps)).toContain(`Hook lookup id=${hookMetadataId(TARGET, "pay")}`);
    expect(rowsOf(steps)).toContain("Tier IDs to mint=2× #4, #7");
    expect(rowsOf(steps).join()).toContain("Allow overspending=no — any excess reverts");
  });

  it("reports a degenerate payload as ambiguous instead of picking a reading", () => {
    // An empty tier list byte-matches both the 721 mint shape and the 3-word
    // buyback swap shape; the decoder must refuse to choose.
    const metadata = build721PayMetadata({ metadataIdTarget: TARGET, tierIdsToMint: [] });
    const steps = describeJBHookMetadata("pay", metadata)!;
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toContain("matches multiple known shapes");
  });

  it("reads buyback cash-out routing and 721 redeems, including both in one envelope", () => {
    const buyback = describeJBHookMetadata(
      "cashOut",
      buildBuybackCashOutMetadata({ hook: HOOK, minimumSwapAmountOut: 123n, skip: true }),
    )!;
    expect(buyback).toHaveLength(1);
    expect(buyback[0].title).toBe("Buyback hook cash-out routing");
    expect(rowsOf(buyback)).toContain("Minimum swap output=123");
    expect(rowsOf(buyback).join()).toContain("Force the direct terminal path=yes");

    const redeem = describeJBHookMetadata(
      "cashOut",
      build721CashOutMetadata({ metadataIdTarget: TARGET, tokenIds: [9n, 12n] }),
    )!;
    expect(redeem).toHaveLength(1);
    expect(redeem[0].title).toBe("721 shop items to redeem");
    expect(rowsOf(redeem)).toContain("Token IDs=#9, #12");

    const combined = describeJBHookMetadata(
      "cashOut",
      createHookMetadata(
        [hookMetadataId(HOOK, "cashOut"), hookMetadataId(TARGET, "cashOut")],
        [
          encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [5n, false]),
          encodeAbiParameters([{ type: "uint256[]" }], [[3n]]),
        ],
      ),
    )!;
    expect(combined.map((step) => step.title)).toEqual([
      "Buyback hook cash-out routing",
      "721 shop items to redeem",
    ]);
  });

  it("rejects malformed or truncated envelopes", () => {
    expect(describeJBHookMetadata("pay", "0x")).toBeNull();
    expect(describeJBHookMetadata("pay", "0xdead")).toBeNull();
    expect(describeJBHookMetadata("pay", `0x${"00".repeat(64)}`)).toBeNull();
    const valid = build721PayMetadata({ metadataIdTarget: TARGET, tierIdsToMint: [4n] });
    expect(describeJBHookMetadata("pay", valid.slice(0, -2))).toBeNull();
  });
});

describe("sucker claim decoding", () => {
  const claim = {
    token: zeroAddress,
    leaf: {
      index: 7n,
      beneficiary: `0x000000000000000000000000${ALICE.slice(2)}`,
      projectTokenCount: 1_000n,
      terminalTokenAmount: 25n,
      metadata: `0x${"00".repeat(32)}`,
    },
    proof: Array.from({ length: 32 }, (_, i) => `0x${String(i).padStart(2, "0").repeat(32)}`),
  };

  it("renders the leaf and summarizes the proof", () => {
    const steps = describeSuckerClaim(1, claim)!;
    expect(steps).toHaveLength(1);
    const rows = rowsOf(steps);
    expect(rows).toContain("Leaf index=7");
    expect(rows).toContain(`Beneficiary=${ALICE}`);
    expect(rows).toContain("Project tokens=1000");
    expect(rows.join()).toContain("Merkle proof=32 hashes");
  });

  it("rejects a claim whose proof is not exactly 32 hashes", () => {
    expect(describeSuckerClaim(1, { ...claim, proof: claim.proof.slice(0, 31) })).toBeNull();
  });
});

describe("Safe execution decoding", () => {
  it("decodes a queued JB call through the candidate ABIs", () => {
    const data = encodeFunctionData({
      abi: jbControllerAbi,
      functionName: "sendReservedTokensToSplitsOf",
      args: [41n],
    });
    const steps = describeSafeInnerCall(data)!;
    expect(steps[0].title).toBe("Queued call — JBController.sendReservedTokensToSplitsOf(…)");
    expect(rowsOf(steps)).toContain("projectId=\"41\"");
  });

  it("returns null for an unknown selector", () => {
    expect(describeSafeInnerCall("0xdeadbeef")).toBeNull();
  });

  it("decodes a canonical Safe initializer, including the SafeToL2Setup hook", () => {
    const plain = encodeFunctionData({
      abi: safeSetupAbi,
      functionName: "setup",
      args: [[ALICE, BOB], 2n, zeroAddress, "0x", HOOK, zeroAddress, 0n, zeroAddress],
    });
    const steps = describeSafeInitializer(1, plain)!;
    const rows = rowsOf(steps);
    expect(rows).toContain(`Owners=${ALICE}, ${BOB}`);
    expect(rows).toContain("Threshold=2 of 2");
    expect(rows).toContain("Setup hook=none");

    const l2Data = encodeFunctionData({
      abi: safeToL2SetupAbi,
      functionName: "setupToL2",
      args: [TARGET],
    });
    const withHook = encodeFunctionData({
      abi: safeSetupAbi,
      functionName: "setup",
      args: [[ALICE], 1n, BOB, l2Data, HOOK, zeroAddress, 0n, zeroAddress],
    });
    expect(rowsOf(describeSafeInitializer(1, withHook)).join()).toContain(
      `SafeToL2Setup.setupToL2(${TARGET})`,
    );
    expect(describeSafeInitializer(1, "0xdeadbeef")).toBeNull();
  });
});

describe("permissions and splits decoding", () => {
  it("names permission ids from the SDK catalog and flags ROOT and the all-projects scope", () => {
    const steps = describePermissionsData(1, {
      operator: BOB,
      projectId: 0n,
      permissionIds: [1, 2, 200],
    })!;
    const rows = rowsOf(steps).join("\n");
    expect(rows).toContain("ROOT (1)");
    expect(rows).toContain("QUEUE_RULESETS (2)");
    expect(rows).toContain("UNKNOWN PERMISSION (200)");
    expect(rows).toContain("EVERY project");
    expect(rows).toContain("Warning=ROOT grants every permission");
    expect(
      rowsOf(describePermissionsData(1, { operator: BOB, projectId: 3n, permissionIds: [] })).join(),
    ).toContain("none — revokes everything");
  });

  it("renders split percents as percentages with an honest total", () => {
    const steps = describeSplitGroups(1, [
      {
        groupId: 1n,
        splits: [
          {
            percent: 500_000_000,
            projectId: 0n,
            beneficiary: ALICE,
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: zeroAddress,
          },
          {
            percent: 250_000_000,
            projectId: 3n,
            beneficiary: BOB,
            preferAddToBalance: false,
            lockedUntil: 0,
            hook: zeroAddress,
          },
        ],
      },
    ])!;
    expect(steps[0].title).toBe("Reserved tokens");
    const rows = rowsOf(steps).join("\n");
    expect(rows).toContain("Split 1 — 50%");
    expect(rows).toContain("Split 2 — 25%");
    expect(rows).toContain(`project #3 (beneficiary ${BOB})`);
    expect(rows).toContain("Total=75% — the remainder follows the ruleset's default");
  });
});
