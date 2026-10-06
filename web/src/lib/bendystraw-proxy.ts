import {
  resolvePersistedBendystrawRequest as resolvePersisted,
  type PersistedBendystrawRequest,
} from '@bananapus/nana-sdk-core/bendystraw-operations'
import registry from '@/lib/bendystraw-operation-registry.json'

export type { PersistedBendystrawRequest }

/** A proxy body resolved against this app's persisted operations. */
export function resolvePersistedBendystrawRequest(
  value: unknown,
): PersistedBendystrawRequest | null {
  return resolvePersisted(value, registry)
}
