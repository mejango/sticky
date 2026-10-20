/**
 * A chunk URL as its path under the dist directory. Next appends the deployment
 * id (`?dpl=…`) to chunk URLs; that suffix is not part of the emitted file.
 * Decode only after removing it, so encoded filename characters stay part of
 * the path.
 */
function chunkPath(url) {
  const path = decodeURIComponent(url.split(/[?#]/u, 1)[0]).replace(/^\/_next\//u, '')
  if (!path.endsWith('.js') || path.split('/').includes('..')) {
    throw new Error(`A page references an unexpected client asset: ${url}`)
  }
  return path
}

/**
 * The client chunks a page loads up front: every `static/chunks/*.js` its HTML
 * names, in script and preload tags or escaped inside the RSC payload, except
 * `nomodule` scripts (polyfills), which modern browsers skip.
 */
export function referencedChunks(html) {
  const unescaped = html.replace(/\\"/gu, '"').replace(/\\u002F|\\\//gu, '/')
  const skipped = new Set(
    [...unescaped.matchAll(/<script\b[^>]*>/giu)]
      .map(([tag]) => tag)
      .filter(tag => /\bnomodule\b/iu.test(tag))
      .map(tag => tag.match(/\bsrc="([^"]+)"/iu)?.[1])
      .filter(Boolean)
      .map(chunkPath),
  )
  return [
    ...new Set(
      [...unescaped.matchAll(/(?:\/_next\/)?static\/chunks\/[^"'\s<>\\]+?\.js(?:[?#][^"'\s<>\\]*)?/gu)]
        .map(([reference]) => chunkPath(reference))
        .filter(path => !skipped.has(path)),
    ),
  ]
}
