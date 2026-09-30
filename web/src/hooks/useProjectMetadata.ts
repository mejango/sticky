'use client'

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { immutableQuery } from '@/lib/query-persist'
import { ipfsGatewayUrl, metadataOfUri, projectUriOf } from '@/lib/sticky-metadata'

/**
 * The name and logo of the Juicebox project behind a Sticky project's staked token, or the launch its uri carries.
 * `data` is undefined until it is known, and stays so when the token is no project's or its uri names nothing to
 * read.
 *
 * The project's uri is read from the chain every visit: its owner can change it. The document a uri names cannot
 * change, so it is keyed by the uri, read once, and kept in the browser for good; it is the one query here that
 * goes to disk. Only an `ipfs://` uri is content addressed, and only one that is a plain gateway path is short
 * enough to be a key, so a data uri, whose document is the uri itself, and any other uri stay in memory.
 * `metadataOfUri` rejects when the gateway does not answer, and a failure is never kept.
 */
export function useProjectMetadata(chainId: number, stakedToken: Address) {
  const uri = useQuery({
    queryKey: ['project-uri', chainId, stakedToken],
    queryFn: ({ signal }) => projectUriOf(chainId, stakedToken, { signal }),
  })
  const found = uri.data ?? null

  return useQuery({
    queryKey: ['project-metadata', found],
    queryFn: ({ signal }) => metadataOfUri(found!, { signal }),
    enabled: found !== null,
    ...(found !== null && ipfsGatewayUrl(found) !== null ? immutableQuery({}) : {}),
  })
}
