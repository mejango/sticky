import { describe, expect, it } from 'vitest'
import { referencedChunks } from '../../scripts/lib/referenced-chunks.mjs'

describe('referencedChunks', () => {
  it('counts chunks whose URL carries the deployment id', () => {
    const html =
      '<script src="/_next/static/chunks/main-app.js?dpl=abc123" async></script>' +
      '<link rel="preload" as="script" href="/_next/static/chunks/app/page-1.js?dpl=abc123"/>'
    expect(referencedChunks(html)).toEqual([
      'static/chunks/main-app.js',
      'static/chunks/app/page-1.js',
    ])
  })

  it('reads chunks escaped inside the RSC payload, once each', () => {
    const html =
      '<script src="/_next/static/chunks/a.js"></script>' +
      '<script>self.__next_f.push([1,"1:I[\\"x\\",[\\"static\\/chunks\\/b.js?dpl=z\\",\\"static\\/chunks\\/a.js\\"]]"])</script>'
    expect(referencedChunks(html)).toEqual(['static/chunks/a.js', 'static/chunks/b.js'])
  })

  it('skips nomodule polyfills', () => {
    const html =
      '<script src="/_next/static/chunks/polyfills.js?dpl=z" noModule=""></script>' +
      '<script src="/_next/static/chunks/main.js?dpl=z"></script>'
    expect(referencedChunks(html)).toEqual(['static/chunks/main.js'])
  })

  it('decodes encoded route segments in chunk paths', () => {
    const html = '<script src="/_next/static/chunks/app/%5Burn%5D/page-9.js?dpl=z"></script>'
    expect(referencedChunks(html)).toEqual(['static/chunks/app/[urn]/page-9.js'])
  })

  it('refuses a chunk path that leaves the dist directory', () => {
    expect(() => referencedChunks('<script src="/_next/static/chunks/%2E%2E/%2E%2E/x.js">')).toThrow()
  })
})
