import registry from '@/lib/bendystraw-operation-registry.json'

export type PersistedBendystrawRequest = {
  query: string
  variables: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function resolvePersistedBendystrawRequest(
  value: unknown,
): PersistedBendystrawRequest | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (
    keys.some(key => key !== 'operation' && key !== 'variables') ||
    typeof value.operation !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.operation) ||
    !isRecord(value.variables)
  ) {
    return null
  }
  const query = (registry as Record<string, string>)[value.operation]
  return query ? { query, variables: value.variables } : null
}
