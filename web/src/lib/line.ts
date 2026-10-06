/** Tasks that wait their turn: at most a line's room of them under way at once, started in the order they joined. */
export type Line = {
  /**
   * `task`, once the line has room for it: what it gives, or its failure, which is its own caller's and holds up no
   * other. A task whose `signal` aborts while it waits leaves the line at once, rejecting with the signal's reason, and
   * never starts. One under way answers to its own signal: the line does not stop it.
   */
  join<T>(task: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  /** Starts what waits, as far as there is room, once `held` no longer holds the line. */
  resume(): void
}

/** A line with room for `room` tasks at once. While `held` says so, nothing new starts, and `resume` starts what waits
 * when it no longer does. */
export function line(room: number, held: () => boolean = () => false): Line {
  let running = 0
  /** What waits, in the order it joined. */
  const waiting: (() => void)[] = []

  const resume = () => {
    while (!held() && running < room && waiting.length) waiting.shift()!()
  }

  const join = <T>(task: () => Promise<T>, { signal }: { signal?: AbortSignal } = {}) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const start = () => {
        signal?.removeEventListener('abort', leave)
        running += 1
        new Promise<T>(begun => begun(task()))
          .then(resolve, reject)
          .finally(() => {
            running -= 1
            resume()
          })
      }
      function leave() {
        const at = waiting.indexOf(start)
        if (at >= 0) waiting.splice(at, 1)
        reject(signal!.reason)
      }
      signal?.addEventListener('abort', leave, { once: true })
      waiting.push(start)
      resume()
    })

  return { join, resume }
}
