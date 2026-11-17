/**
 * The one way a Bendystraw document runs. In the browser it goes to this
 * site's own relay as its registered operation ID and variables; on the server
 * it goes to the indexer of its network. Documents are static strings built
 * from module constants, and `npm run bendystraw:registry` registers them.
 * A caller's `signal` cancels the request under way, and the transport does
 * not retry a request that was cancelled. A request the indexer refused for
 * its rate fails as a 429, which no caller's retry rule asks again.
 */

import {
  bendystrawCacheTtl,
  normalizeBendystrawEndpoint,
  requestBendystraw,
  resolveBendystrawNetwork,
  selectBendystrawEndpoint,
  type BendystrawCachePolicy,
  type BendystrawNetwork,
} from '@bananapus/nana-sdk-core'
import {
  compileBendystrawDocument,
  requestPersistedBendystraw,
} from '@bananapus/nana-sdk-core/bendystraw-operations'
import type { DocumentNode } from 'graphql'
import parsedDocuments from '@/lib/bendystraw-documents.json'

// Every document parsed at build time by `npm run bendystraw:registry`, so the browser does not bundle the GraphQL
// parser; `npm run schema:check:offline` fails when one is missing or stale.
const DOCUMENTS = parsedDocuments as unknown as Record<string, DocumentNode>

export function normalizeBendystrawUrl(value: string): string {
  return normalizeBendystrawEndpoint(value.trim())
}

const MAINNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_BENDYSTRAW_URL?.trim() ||
        'https://bendystraw.up.railway.app',
    )
const TESTNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL?.trim() ||
        'https://testnet.bendystraw.xyz',
    )
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

export async function bendystraw<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: {
    chainId?: number
    network?: BendystrawNetwork
    /** `'no-store'` bypasses Next's fetch cache, which keeps a disk file for every distinct request. */
    policy?: BendystrawCachePolicy | 'no-store'
    /** Ask the indexer once. The relay passes it: the browser's request behind it does the retrying. */
    once?: boolean
    signal?: AbortSignal
  } = {},
): Promise<T> {
  const document = Object.hasOwn(DOCUMENTS, query) ? DOCUMENTS[query] : undefined
  if (!document) throw new Error('This Bendystraw document is not registered; run npm run bendystraw:registry')
  const contract = compileBendystrawDocument(document)
  const network = resolveBendystrawNetwork({
    chainId: opts.chainId,
    defaultNetwork: 'mainnet',
    network: opts.network,
    variables,
  })
  if (typeof window !== 'undefined') {
    return requestPersistedBendystraw<T>({
      contract,
      network,
      query,
      signal: opts.signal,
      variables,
    })
  }
  const cacheOptions =
    opts.policy === 'no-store'
      ? { cache: 'no-store' as const }
      : IS_DETERMINISTIC_BROWSER
        ? { next: { revalidate: 1 } }
        : {
            next: {
              revalidate: bendystrawCacheTtl(opts.policy ?? 'stable') / 1_000,
            },
          }
  let refused: Response | undefined
  try {
    return await requestBendystraw<T, Record<string, unknown>>(
      selectBendystrawEndpoint(
        { mainnet: MAINNET_URL, testnet: TESTNET_URL },
        {
          chainId: opts.chainId,
          network,
          variables,
        },
      ),
      query,
      variables,
      {
        fetch: async (input, init) => {
          const response = await fetch(input, { ...init, ...cacheOptions })
          refused = response.status === 429 ? response : undefined
          return response
        },
        operationName: contract.operationName,
        signal: opts.signal,
        validateData: (value): value is T => contract.validateData(value),
        validateVariables: contract.validateVariables,
        ...(opts.once ? { retryDelaysMs: [] } : {}),
      },
    )
  } catch (error) {
    // The indexer refuses in plain text, which the SDK reports as an invalid answer (502). Its last answer says it was
    // the rate, with the seconds it asked for when it gave them.
    if (!refused) throw error
    throw Object.assign(new Error('Bendystraw refused the request for its rate', { cause: error }), {
      status: 429,
      retryAfter: Number(refused.headers.get('retry-after')) || undefined,
    })
  }
}
