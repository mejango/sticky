import { ReviewLineError } from '@bananapus/nana-sdk-core/review'

/** What a holder asked for and cannot have, or an answer the chain gave: said to them, and no failure of the page's own,
 * so the console is not told of it. */
export class Refusal extends ReviewLineError {}

/**
 * `reason` as a refusal when it is a line of the page's own that carries no cause, and as it is otherwise. A read that
 * failed to be made keeps its cause (`asked`, `need`), and the page's lines for the chain's answers carry none, like a
 * stick that would mint nothing (`quoteStick`) or a hook that does not let a sender stick for a holder.
 */
export function refusalOf(reason: unknown): unknown {
  return reason instanceof ReviewLineError && reason.cause === undefined && !(reason instanceof Refusal) ? new Refusal(reason.message) : reason
}

/** A read's failure as an error the holder is told of. The console is told why as well when the read failed to be made,
 * which its cause says: a refusal, like a holder who has not trusted the sender, has none. */
export function told(label: string, about: object, reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  if (error.cause !== undefined) console.warn(label, about, error)
  return error
}
