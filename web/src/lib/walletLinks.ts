// ipfs.io 302s page loads to the inbrowser.link service worker (sunset 2026-09-21) and path gateways either
// send a default-src 'self' CSP (Filebase) or download HTML (JB Center), so wallet browsers get the eth.sucks
// subdomain gateway, which serves the site without a service worker.
const WALLET_SAFE_GATEWAY_HOST = 'eth.sucks'
const SUBDOMAIN_IPFS_SUFFIXES = [
  '.ipfs.inbrowser.link',
  '.ipfs.dweb.link',
  '.ipfs.w3s.link',
] as const

function ipfsPathUrl(
  cid: string,
  pathname: string,
  search: string,
  hash: string,
) {
  return `https://${cid}.${WALLET_SAFE_GATEWAY_HOST}${pathname || '/'}${search}${hash}`
}

/** Use a non-service-worker gateway in wallet browsers, which may not support IPFS gateway service workers. */
export function walletDappUrl(href: string) {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }

  const hostname = url.hostname.toLowerCase()
  for (const suffix of SUBDOMAIN_IPFS_SUFFIXES) {
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
      return ipfsPathUrl(
        hostname.slice(0, -suffix.length),
        url.pathname,
        url.search,
        url.hash,
      )
    }
  }

  if (hostname === 'ipfs.inbrowser.link') {
    const match = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (match) {
      return ipfsPathUrl(
        match[1],
        match[2] || '/',
        url.search,
        url.hash,
      )
    }
  }

  return href
}

export function mobileWalletLinks(href: string) {
  const full = walletDappUrl(href)
  const schemeless = encodeURIComponent(full.replace(/^https?:\/\//i, ''))
  const encoded = encodeURIComponent(full)
  return [
    { name: 'MetaMask', url: `https://metamask.app.link/dapp/${schemeless}` },
    { name: 'Coinbase Wallet', url: `https://go.cb-w.com/dapp?cb_url=${encoded}` },
    {
      name: 'Trust Wallet',
      url: `https://link.trustwallet.com/open_url?coin_id=60&url=${encoded}`,
    },
  ]
}

export function isMobileDevice(nav: {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
}) {
  return (
    /Android|iPhone|iPad|iPod/i.test(nav.userAgent || '') ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  )
}
