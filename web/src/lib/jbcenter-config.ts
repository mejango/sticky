import { JBCENTER_DEFAULT_URL } from '@bananapus/nana-sdk-core/jbcenter'

const PRODUCTION_SITE_URL = 'https://sticky.center'
const LOCAL_SITE_URL = 'http://127.0.0.1:8788'
const DEV_CENTER_URL = 'https://dev.juicebox.center'
const DEV_ORIGINS = new Set(['http://127.0.0.1:8788', 'https://sticky-dev.up.railway.app', 'https://dev.sticky.center'])

/** Match the reference apps' SDK transport and environment selection. A
 * deployment can supply its own JB Center endpoint, without borrowing another
 * application's origin or credentials. */
export function jbCenterBaseUrl(
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  return (
    process.env.NEXT_PUBLIC_JBCENTER_URL ||
    (DEV_ORIGINS.has(jbCenterAppOrigin(siteUrl)) ? DEV_CENTER_URL : JBCENTER_DEFAULT_URL)
  )
}

/** Browser requests use the browser's real Origin header. Server requests must
 * identify this deployment too; JB Center must explicitly allow this origin. */
export function jbCenterAppOrigin(
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  return new URL(siteUrl || (process.env.NODE_ENV === 'development' ? LOCAL_SITE_URL : PRODUCTION_SITE_URL)).origin
}
