// @vitest-environment node

import { parse } from 'graphql'
import { describe, expect, it } from 'vitest'
import { bendystraw } from '@/lib/bendystraw'
import documents from '@/lib/bendystraw-documents.json'
import registry from '@/lib/bendystraw-operation-registry.json'

describe('the parsed Bendystraw documents', () => {
  it('hold every registered document, parsed without locations, and nothing else', () => {
    expect(Object.keys(documents).sort()).toEqual(Object.values(registry).sort())
    for (const [query, parsed] of Object.entries(documents)) expect(parsed).toEqual(parse(query, { noLocation: true }))
  })

  it('refuse a document the build did not register, before anything is asked', async () => {
    await expect(bendystraw('query Unregistered { projects { totalCount } }', {})).rejects.toThrow('not registered')
  })
})
