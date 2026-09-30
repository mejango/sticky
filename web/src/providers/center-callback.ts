type CallbackLocation = { href: string; replace(path: string): void }
/** Runs before loading the wallet SDK. The original callback lives only in this module's
 * memory until the SDK validates and journals it; it is never copied into an app URL. */
export function captureCenterCallback(location: CallbackLocation): { url: string } | null {
  const url = new URL(location.href)
  if (url.pathname !== '/center/callback') return null
  location.replace('/center/callback')
  return { url: url.href }
}
// A local path of Sticky's own routes (`/base:23`, `/@handle`, `/account/0x…`). Each segment is one or more of
// `a-z A-Z 0-9 _ . : @ -` or a percent escape other than an encoded slash. Segments are split by a mandatory
// `/`, so the match is linear in the length of the value.
const SEGMENT = String.raw`(?:[a-zA-Z0-9_.:@-]|%(?!2[fF]|5[cC])[0-9a-fA-F]{2})+`
const RETURN_PATH = new RegExp(String.raw`^/(?:${SEGMENT}(?:/${SEGMENT})*/?)?$`)
export function centerReturnPath(value: string): string {
  if (typeof value !== 'string' || value.length > 1024 || !RETURN_PATH.test(value) || value.startsWith('/center/'))
    throw new Error('The original Sticky page is unavailable.')
  return value
}
let captured: { url: string } | null = null
let failure: unknown
if (typeof window !== 'undefined') {
  try { captured = captureCenterCallback({ href: window.location.href, replace: path => window.history.replaceState(null, '', path) }) }
  catch (error) { failure = error }
}
export function capturedCenterCallback() {
  if (failure) throw new Error('The wallet callback could not be cleared safely.')
  return captured
}
/** Next's router writes back the URL it booted with once it mounts, callback data included, so the page clears the
 * address bar again before it hands the callback to the SDK or to the page that framed it. */
export function clearCenterCallbackUrl() {
  if (window.location.pathname === '/center/callback' && (window.location.search || window.location.hash))
    window.history.replaceState(null, '', '/center/callback')
}
