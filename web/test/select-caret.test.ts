import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sourcesUnder } from './source-gates'

// A native select keeps the browser's arrow flush against its right edge unless it draws its own: `select-caret`
// with room for it (`pr-9`), or `appearance-none`, or an invisible select laid over its own drawing.

describe('every dropdown of the site', () => {
  it('draws its own caret with room beside it, never the browser\'s arrow at the edge', () => {
    const bare = sourcesUnder('src').filter(file => file.endsWith('.tsx')).flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/<select\b[^]*?<\/select>/g)]
        .map(([tag]) => tag.slice(0, tag.indexOf('<option') === -1 ? undefined : tag.indexOf('<option')))
        .filter(open => !(/\bselect-caret\b/.test(open) && /\bpr-9\b/.test(open)) && !/\bappearance-none\b|\bopacity-0\b/.test(open))
        .map(open => `${file}: ${open.slice(0, 80)}`))
    expect(bare).toEqual([])
  })
})
