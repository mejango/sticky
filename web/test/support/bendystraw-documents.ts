import { parse } from 'graphql'

/** In place of the build's parsed documents: any document a test writes, parsed as the registry script parses it. */
export const anyDocument = new Proxy({}, {
  get: (_target, query) => (typeof query === 'string' ? parse(query, { noLocation: true }) : undefined),
  getOwnPropertyDescriptor: (_target, query) =>
    typeof query === 'string'
      ? { configurable: true, enumerable: true, value: parse(query, { noLocation: true }) }
      : undefined,
})
