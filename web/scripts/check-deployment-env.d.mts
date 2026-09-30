export type DeploymentPhase = 'build' | 'runtime' | 'all'
export function deploymentEnvErrors(
  env: Record<string, string | undefined>,
  phase?: DeploymentPhase,
): string[]
export function assertDeploymentEnv(
  env: Record<string, string | undefined>,
  phase?: DeploymentPhase,
): void
