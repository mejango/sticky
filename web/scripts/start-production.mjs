import { assertDeploymentEnv } from './check-deployment-env.mjs'

// Assigning undefined to process.env stores the string "undefined", which
// would pass for a revision. Set the variable only when Railway has one.
const railwayRevision = process.env.RAILWAY_GIT_COMMIT_SHA?.trim()
if (!process.env.NEXT_PUBLIC_VERSION && railwayRevision) {
  process.env.NEXT_PUBLIC_VERSION = railwayRevision
}
assertDeploymentEnv(process.env, 'all')
await import('../server.js')
