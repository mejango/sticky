export async function bendystrawOperationId(query: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query))
  let id = ''
  for (const byte of new Uint8Array(digest)) id += byte.toString(16).padStart(2, '0')
  return id
}
