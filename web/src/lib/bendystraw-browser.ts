import { requestBendystraw, type BendystrawNetwork } from '@bananapus/nana-sdk-core'
import {
  bendystrawOperationId,
  type BendystrawOperationContract,
} from '@bananapus/nana-sdk-core/bendystraw-operations'

export async function requestPersistedBendystraw<T>(args: {
  contract: BendystrawOperationContract
  network: BendystrawNetwork
  query: string
  signal?: AbortSignal
  variables: Record<string, unknown>
}): Promise<T> {
  const operation = await bendystrawOperationId(args.query)
  return requestBendystraw<T, Record<string, unknown>>(
    `/api/bendystraw/${args.network}/query`,
    args.query,
    args.variables,
    {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          body: JSON.stringify({
            operation,
            variables: args.variables,
          }),
          cache: 'no-store',
        }),
      operationName: args.contract.operationName,
      signal: args.signal,
      validateData: (value): value is T => args.contract.validateData(value),
      validateVariables: args.contract.validateVariables,
    },
  )
}
