import { describe, expect, it } from 'vitest'
import {
  decodeProjectRouteSegment,
  projectRouteSegmentFromPathname,
} from '@/lib/project-handles'

describe('project route segments', () => {
  it('decodes a segment once, and rejects text that is not valid percent-encoding', () => {
    expect(decodeProjectRouteSegment('%40design.juicebox')).toBe('@design.juicebox')
    expect(decodeProjectRouteSegment('%2540design.juicebox')).toBe('%40design.juicebox')
    expect(decodeProjectRouteSegment('%E0%A4%A')).toBeNull()
  })

  it('reads the one top-level segment of a client pathname', () => {
    expect(projectRouteSegmentFromPathname('/base:23')).toBe('base:23')
    expect(projectRouteSegmentFromPathname('/base%3A23')).toBe('base:23')
    expect(projectRouteSegmentFromPathname('/@design.juicebox')).toBe('@design.juicebox')
    expect(projectRouteSegmentFromPathname('/')).toBeNull()
    expect(projectRouteSegmentFromPathname('')).toBeNull()
  })

  it('decodes client pathnames once, including Unicode, and rejects double encoding', () => {
    expect(projectRouteSegmentFromPathname('/%40caf%C3%A9.juicebox')).toBe('@café.juicebox')
    expect(projectRouteSegmentFromPathname('/%2540design.juicebox')).toBeNull()
  })

  it('is not a top-level route when the path has more than one segment', () => {
    expect(projectRouteSegmentFromPathname('/base:7/owner')).toBeNull()
    expect(projectRouteSegmentFromPathname('/account/0x1111111111111111111111111111111111111111')).toBeNull()
  })

  it('reads nothing from a malformed escape', () => {
    expect(projectRouteSegmentFromPathname('/%E0%A4%A')).toBeNull()
  })
})
