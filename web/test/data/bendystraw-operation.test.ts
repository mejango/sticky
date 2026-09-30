// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { compileBendystrawOperation } from '@/lib/bendystraw-operation'

describe('a compiled Bendystraw operation', () => {
  it('has the name of its one operation', () => {
    expect(compileBendystrawOperation('query Named { a }').operationName).toBe(
      'Named',
    )
    expect(compileBendystrawOperation('query { a }').operationName).toBeUndefined()
    expect(() => compileBendystrawOperation('fragment F on T { a }')).toThrow(
      'exactly one operation',
    )
    expect(() =>
      compileBendystrawOperation('query A { a } query B { b }'),
    ).toThrow('exactly one operation')
  })

  it('checks each variable against its declared scalar type', () => {
    const { validateVariables } = compileBendystrawOperation(
      'query Scalars($flag: Boolean!, $id: ID!, $name: String!, $count: Int!, $ratio: Float!) { a }',
    )
    const valid = { flag: true, id: 'a', name: 'x', count: 2, ratio: 0.5 }

    expect(validateVariables(valid)).toBe(true)
    expect(validateVariables({ ...valid, id: 7 })).toBe(true)
    expect(validateVariables({ ...valid, ratio: 2 })).toBe(true)
    for (const wrong of [
      { flag: 'true' },
      { id: 1.5 },
      { name: 1 },
      { count: 1.5 },
      { count: '1' },
      { count: 2 ** 53 },
      { ratio: '0.5' },
      { ratio: Number.POSITIVE_INFINITY },
      { ratio: Number.NaN },
    ]) {
      expect(validateVariables({ ...valid, ...wrong })).toBe(false)
    }
  })

  it('needs a non-null variable unless it has a default, and takes null for the rest', () => {
    const { validateVariables } = compileBendystrawOperation(
      'query Nulls($need: Int!, $defaulted: Int! = 10, $limit: Int = 10, $after: String) { a }',
    )

    expect(validateVariables({ need: 1 })).toBe(true)
    expect(validateVariables({ need: 1, limit: null, after: null })).toBe(true)
    expect(validateVariables({})).toBe(false)
    expect(validateVariables({ need: null })).toBe(false)
    expect(validateVariables({ need: 1, defaulted: null })).toBe(false)
  })

  it('takes a single value where a list is declared, and checks every item', () => {
    const { validateVariables } = compileBendystrawOperation(
      'query Lists($owners: [String!]) { a }',
    )

    expect(validateVariables({ owners: ['0xa', '0xb'] })).toBe(true)
    expect(validateVariables({ owners: '0xa' })).toBe(true)
    expect(validateVariables({ owners: [] })).toBe(true)
    expect(validateVariables({ owners: ['0xa', null] })).toBe(false)
    expect(validateVariables({ owners: ['0xa', 1] })).toBe(false)
  })

  it('checks a response against the selection, aliases and nested lists included', () => {
    const { validateData } = compileBendystrawOperation(
      'query Shape { project { id owner { name } } rows: things { items { id } } }',
    )
    const valid = {
      project: { id: 1, owner: { name: 'x' } },
      rows: { items: [{ id: 1 }, { id: 2 }] },
    }

    expect(validateData(valid)).toBe(true)
    expect(validateData({ ...valid, project: null })).toBe(true)
    expect(validateData({ ...valid, project: { id: 1, owner: null } })).toBe(true)
    expect(validateData({ ...valid, rows: { items: [] } })).toBe(true)
    for (const wrong of [
      null,
      [],
      {},
      { project: valid.project },
      { project: valid.project, things: valid.rows },
      { ...valid, project: { id: 1 } },
      { ...valid, project: 'x' },
      { ...valid, rows: { items: [{ id: 1 }, {}] } },
      { ...valid, rows: { items: [{ id: 1 }, 'x'] } },
    ]) {
      expect(validateData(wrong)).toBe(false)
    }
  })
})
