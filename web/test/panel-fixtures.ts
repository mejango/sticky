import { QueryClient } from '@tanstack/react-query'

/** A client with Providers' defaults: fresh for 30 seconds, one more try after a failure, no refetch on focus. */
export const siteClient = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false } },
  })

/** What a browser tells of an element that enters or leaves the viewport, for the panel that watches its own. */
export class FakeObserver {
  static all: FakeObserver[] = []
  element: Element | null = null
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.all.push(this)
  }
  observe(element: Element) {
    this.element = element
  }
  unobserve() {}
  disconnect() {
    FakeObserver.all = FakeObserver.all.filter(each => each !== this)
  }
  takeRecords() {
    return []
  }
  /** Tells every observer what the browser noticed, oldest first: one entry for each of `noticed`. */
  static tell(...noticed: boolean[]) {
    for (const each of FakeObserver.all) {
      const entries = noticed.map(isIntersecting => ({ isIntersecting, target: each.element }) as IntersectionObserverEntry)
      each.callback(entries, each as unknown as IntersectionObserver)
    }
  }
}
