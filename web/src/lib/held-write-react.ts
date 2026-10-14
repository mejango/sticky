'use client'
/* eslint-disable react-hooks/exhaustive-deps, react-hooks/immutability -- copied as the SDK ships and tests it: memo keys stand for their values, and a lifecycle counts its own requests. */

/**
 * ponytail: a thin, swappable copy of nana-sdk-react 53's useHeldWrite and useSavedAttempt, bound to core's
 * framework-free createHeldWriteView and createSavedAttemptRecovery. nana-sdk-react 53 peers on wagmi 2; Sticky runs
 * wagmi 3. Replace this file's imports with `@bananapus/nana-sdk-core/review/react` (SDK 2.40) and delete it. Nothing
 * here decides anything: the rules are the SDK's.
 */
import {
  checkedItLabel,
  createHeldWriteView,
  followHeldWrite,
  HELD_EXIT_LABEL,
  HELD_SEND_AGAIN_LABEL,
  SAVED_ATTEMPT_CONTINUE_ANYWAY_LABEL,
  SAVED_ATTEMPT_UNREADABLE_LINE,
  type HeldWriteEvidence,
  type HeldWriteView,
  type HeldWriteViewController,
  type ReviewedWriteRecoveryInput,
  type SavedAttempt,
  type SavedAttemptOutcome,
  type SavedAttemptRecovery,
  type SavedAttemptRetirement,
  type WriteHold,
  type WriteHoldClient,
  type WriteHoldGate,
  type WriteHoldHandle,
  type WriteHoldSettled,
  type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Address, Hex, TransactionReceipt } from 'viem'

/** A call stand-in for a hold found by its intent alone, before any call is built. */
const NO_CALL = {
  to: "0x0000000000000000000000000000000000000000" as Address,
  data: "0x" as Hex,
};

export type UseHeldWriteOptions = {
  /** The app's one write hold controller (createWriteHold()). */
  hold: WriteHold;
  chainId: number;
  /** The account that sends: the wallet, or the Safe. */
  account: Address;
  /** Whether `account` is a Safe whose writes are proposals. */
  safe?: boolean;
  /** The action's intent key (payIntent and the other builders). */
  namespace?: string;
  /** Keys an earlier version held this write under. */
  legacy?: Parameters<WriteHold["open"]>[1] extends infer O
    ? O extends { legacy?: infer L }
      ? L
      : never
    : never;
  /** The reviewed call, when built; without one, the hold is found by `namespace`. */
  call?: ReviewedWriteRecoveryInput["call"];
  /** Reads the account's chain. */
  client: WriteHoldClient | undefined;
  /** A previous deploy's saved evidence of this write: adopted before any send. */
  adopt?: () => Promise<HeldWriteEvidence | null | undefined>;
  onAdopted?: (state: WriteHoldState) => void;
  /** The hold settled what this view saw held, on authenticated evidence: once. */
  onSettled?: (
    settled: WriteHoldSettled,
    receipt: TransactionReceipt | null,
  ) => void;
  /** Released: by the user's exit (reopen the review), or by another window. */
  onReleased?: (by: "user" | "other-tab") => void;
  /** How often a held write is asked again (15 s to 60 s, 30 s by default). */
  pollMs?: number;
};

export type UseHeldWriteResult = HeldWriteView & {
  /** The exit the hold offers now, with its label; null when none. */
  exitAction: { label: string; run: () => Promise<boolean> } | null;
  /**
   * On a success settled while away ("This went through while you were
   * away."): the user's choice to send it again. Null otherwise.
   */
  sendAgainAction: { label: string; run: () => Promise<void> } | null;
  /** Send under the hold, once any adoption is done. */
  send: (run: (gate: WriteHoldGate) => Promise<Hex>) => Promise<Hex>;
  /** Ask the chain now. */
  check: () => Promise<HeldWriteView>;
  /** The hold handle, for anything else. */
  handle: WriteHoldHandle | undefined;
};

const IDLE: HeldWriteView = {
  phase: "clear",
  state: null,
  line: null,
  exit: false,
  adopting: false,
};
const none = () => () => {};
/** A value's identity for a memo key, wei amounts (bigints) included. */
const callKeyOf = (value: unknown) =>
  JSON.stringify(value, (_, field) =>
    typeof field === "bigint" ? `${field}n` : field,
  );
const idle = () => IDLE;

/**
 * One held write, the one way every app runs it: its send under the hold,
 * the watch, the shared follower of its transaction or Safe proposal, its
 * one line, its exit and the adoption of a previous deploy's record.
 *
 * The exit only releases the hold: `onReleased("user")`
 * is where the app reopens its review, so a resend always shows the values it
 * sends. A release by another window is neutral (`releasedBy: "other-tab"`),
 * and `onSettled` fires only for a settlement of what this view saw held.
 */
export function useHeldWrite(options: UseHeldWriteOptions): UseHeldWriteResult {
  const {
    hold,
    chainId,
    account,
    safe = false,
    namespace,
    client,
    pollMs,
  } = options;
  const callKey = callKeyOf(options.call ?? null);
  const legacyKey = callKeyOf(options.legacy ?? null);
  const latest = useRef(options);
  latest.current = options;
  const handle = useMemo(() => {
    const call = latest.current.call;
    if (!call && !namespace) return undefined;
    const legacy = latest.current.legacy;
    return hold.open(
      {
        chainId,
        account,
        safe,
        call: call ?? NO_CALL,
        ...(namespace ? { namespace } : {}),
      },
      legacy ? { legacy } : undefined,
    );
    // The call and legacy keys stand for their values.
  }, [hold, chainId, account, safe, namespace, callKey, legacyKey]);
  // Whether the app has a previous deploy's record to adopt: a change makes a
  // new view, whose adoption runs before any send.
  const adopts = !!options.adopt;
  /** The view whose callbacks are the app's now: an earlier one's late answers reach none. */
  const active = useRef<HeldWriteViewController | undefined>(undefined);
  const view = useMemo(() => {
    if (!handle || !client) return undefined;
    /** Only while this view is the app's: an earlier one's late answers reach no callback. */
    const own =
      <A extends unknown[]>(callback: (...args: A) => void) =>
      (...args: A) => {
        if (active.current === created) callback(...args);
      };
    const created: HeldWriteViewController = createHeldWriteView(handle, {
      client,
      pollMs,
      onSettled: own((settled, receipt) =>
        latest.current.onSettled?.(settled, receipt),
      ),
      onReleased: own((by) => latest.current.onReleased?.(by)),
      onAdopted: own((state) => latest.current.onAdopted?.(state)),
      // A view made with a provider: the app's current one (a removed one
      // makes a new view, and this one stops).
      ...(adopts ? { adopt: () => latest.current.adopt!() } : {}),
    });
    return created;
  }, [handle, client, pollMs, adopts]);
  useEffect(() => {
    if (!view) return;
    active.current = view;
    const stop = view.start();
    return () => {
      if (active.current === view) active.current = undefined;
      stop();
    };
  }, [view]);
  const shown = useSyncExternalStore(
    view?.subscribe ?? none,
    view?.get ?? idle,
    view?.get ?? idle,
  );
  return {
    ...shown,
    exitAction:
      shown.exit && view ? { label: HELD_EXIT_LABEL, run: view.exit } : null,
    sendAgainAction:
      shown.phase === "succeeded" && view
        ? { label: HELD_SEND_AGAIN_LABEL, run: view.acknowledge }
        : null,
    send: (run) => {
      if (!view)
        return Promise.reject(
          new Error("Connect a wallet and build the call before sending."),
        );
      // A record to adopt that this view doesn't know of yet: never send past it.
      if (!!latest.current.adopt !== adopts)
        return Promise.reject(
          new Error(
            "Saved transactions are still being checked. Try again in a moment.",
          ),
        );
      return view.send(run);
    },
    check: () => (view ? view.check() : Promise.resolve(IDLE)),
    handle,
  };
}


export type UseSavedAttemptOptions<T> = {
  /** The app's one saved-attempt recovery (createSavedAttemptRecovery()). */
  recovery: SavedAttemptRecovery;
  /** The saved attempt; none while nothing is saved. */
  attempt: SavedAttempt<T> | null | undefined;
  /** Reads the attempt's chain. */
  client: WriteHoldClient | undefined;
  /** The check action's next step: "I checked it. <next>." ("Review it again" by default). */
  checkNext?: string;
};

/** What a retirement returned: whether it took, and whether it outlives this tab. */
type Retired = Awaited<ReturnType<SavedAttemptRecovery["retire"]>>;

export type UseSavedAttemptResult<T> = {
  /** How recovery ended; null until it has, or with no attempt. */
  outcome: SavedAttemptOutcome<T> | null;
  recovering: boolean;
  /** Recover again now: also "Check again" on a success whose details are unavailable. */
  recover: () => Promise<SavedAttemptOutcome<T> | null>;
  /** On `check`: the one explicit action, which retires the attempt for every tab and reload. */
  checkAction: {
    line: string;
    warning: string;
    label: string;
    run: () => Promise<Retired>;
  } | null;
  /**
   * Only after the check action came back `reason: "unreadable"` (the browser
   * has storage it can't read): the warned exit, "I checked my wallet.
   * Continue anyway", which retires in this tab alone if storage still can't
   * be read. Never a first option.
   */
  unreadableAction: {
    line: string;
    label: string;
    run: () => Promise<Retired>;
  } | null;
  /**
   * Retire after the user's exit or a followed settlement; recovers again.
   * Bound to the attempt it was rendered for: called after that attempt (or
   * its recovery or client) changed, it refuses before anything is saved.
   */
  retire: (reason: SavedAttemptRetirement) => Promise<Retired>;
};

const keyOf = (attempt: SavedAttempt<unknown> | null | undefined) =>
  attempt
    ? JSON.stringify({ ...attempt, authenticate: undefined }, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )
    : null;

/**
 * One saved attempt's recovery, the one way every app runs it: recovered
 * when it (or the client) appears, before the app prepares any new send, with
 * the check action ready on `check`. Every answer and callback belongs to the
 * attempt, recovery and client it started with: an earlier one's, or an older
 * request's, never reaches the current one.
 */
export function useSavedAttempt<T>(
  options: UseSavedAttemptOptions<T>,
): UseSavedAttemptResult<T> {
  const { recovery, client, checkNext } = options;
  const key = keyOf(options.attempt);
  const attempt = options.attempt;
  /** The attempt as last rendered: the same saved fields, with the app's newest callbacks. */
  const latest = useRef(attempt);
  latest.current = attempt;
  /** One lifecycle per attempt, recovery and client, with its latest request. */
  const lifecycle = useMemo(
    () => ({ attempt, recovery, client, request: 0 }),
    // The key stands for the attempt.
    [key, recovery, client],
  );
  type Lifecycle = typeof lifecycle;
  /** Whether `of` is the mounted hook's lifecycle now. */
  const current = (of: Lifecycle) => mounted.current && rendered.current === of;
  /**
   * The lifecycle last rendered: set during render, so a callback of an
   * earlier one is refused from the next commit's first layout effect on. A
   * render React then discards leaves the shown callbacks refused (fail
   * closed) until the next commit.
   */
  const rendered = useRef<Lifecycle | undefined>(undefined);
  rendered.current = lifecycle;
  /** Whether the hook is mounted: no callback or answer acts after unmount. */
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [shown, setShown] = useState<{
    of?: Lifecycle;
    outcome: SavedAttemptOutcome<T> | null;
    recovering: boolean;
  }>({ outcome: null, recovering: false });
  /** The lifecycle whose check action last found storage unreadable. */
  const [unreadable, setUnreadable] = useState<Lifecycle | undefined>();

  const recover = useCallback(async () => {
    const { recovery, client } = lifecycle;
    const attempt = latest.current;
    if (!attempt || !client || !current(lifecycle)) return null;
    const request = ++lifecycle.request;
    setShown((now) => ({
      of: lifecycle,
      outcome: now.of === lifecycle ? now.outcome : null,
      recovering: true,
    }));
    const outcome = await recovery.recover(attempt, client);
    // Only the latest request of the mounted lifecycle shows.
    if (!current(lifecycle) || lifecycle.request !== request) return null;
    setShown({ of: lifecycle, outcome, recovering: false });
    return outcome;
  }, [lifecycle]);

  useEffect(() => {
    void recover();
  }, [recover]);

  const retire = useCallback(
    async (reason: SavedAttemptRetirement): Promise<Retired> => {
      const { recovery } = lifecycle;
      const attempt = latest.current;
      if (!attempt || !current(lifecycle)) return { retired: false };
      const retired = await recovery.retire(attempt, reason);
      if (!current(lifecycle)) return retired;
      if (!retired.retired && retired.reason === "unreadable")
        setUnreadable(lifecycle);
      await recover();
      return retired;
    },
    [lifecycle, recover],
  );

  const outcome = shown.of === lifecycle ? shown.outcome : null;
  return {
    outcome,
    recovering: shown.of === lifecycle && shown.recovering,
    recover,
    checkAction:
      outcome?.status === "check"
        ? {
            line: outcome.line,
            warning: outcome.warning,
            label: checkedItLabel(checkNext),
            run: () => retire({ by: "check", outcome }),
          }
        : null,
    unreadableAction:
      outcome?.status === "check" && unreadable === lifecycle
        ? {
            line: SAVED_ATTEMPT_UNREADABLE_LINE,
            label: SAVED_ATTEMPT_CONTINUE_ANYWAY_LABEL,
            run: () => retire({ by: "check", outcome, force: "unreadable" }),
          }
        : null,
    retire,
  };
}

/**
 * Keep following a held write whose flow closed, with the SDK's own follower, until the hold is clear; then `onSettled`
 * hears an authenticated success. Returns the stop. (Sticky's: a Safe proposal still refreshes its reads once it runs.)
 */
export function followDetached(handle: WriteHoldHandle, client: WriteHoldClient, onSettled: () => void): () => void {
  const stop = new AbortController()
  void followHeldWrite(handle, client, { signal: stop.signal }).then(end => {
    if (end?.status === 'clear' && end.settled && 'hash' in end.settled && end.settled.result === 'success') onSettled()
  }, () => undefined)
  return () => stop.abort()
}
