/** What a holder asked for and cannot have, or an answer the chain gave: said to them, and no failure of the page's own,
 * so the console is not told of it. */
export class Refusal extends Error {}

/**
 * `reason` as a refusal when it is an error that carries no cause, and as it is otherwise. A read that failed to be made
 * keeps its cause (`asked`, `need`), and the chain's answers carry none, like a stick that would mint nothing
 * (`quoteStick`) or a hook that does not let a sender stick for a holder.
 */
export function refusalOf(reason: unknown): unknown {
  return reason instanceof Error && reason.cause === undefined && !(reason instanceof Refusal) ? new Refusal(reason.message) : reason
}
