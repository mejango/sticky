'use client'

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo,
  useRef, useState, type PropsWithChildren,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { ProjectRouteBlockedContext } from '@/providers/ProjectRouteBlockedContext'
import { projectRouteSegmentFromPathname } from '@/lib/project-route'
import {
  projectRouteIdentity, projectRouteIsFresh, projectRouteQueryKey,
  readProjectRouteSnapshot, type ProjectRouteSnapshot,
} from '@/lib/project-route'

export type ResolvedProjectRoute = { chainId: JBChainId; projectId: number; handle: string | null }
const NAVIGATE = 'project-route-navigate'
const INVALIDATE = 'project-route-invalidated'

export type ProjectReviewScope = { identity: string; verify: () => Promise<boolean> }

type NavigationState = 'ready' | 'checking' | 'mismatched' | 'replacing' | 'error'
type ProjectRouteContextValue = {
  route: ResolvedProjectRoute | null
  scope: ProjectReviewScope | null
  state: NavigationState
  error: string | null
  register: (snapshot: ProjectRouteSnapshot) => () => void
  retry: () => void
}

const ProjectRouteContext = createContext<ProjectRouteContextValue>({
  route: null, scope: null, state: 'ready', error: null, register: () => () => undefined, retry: () => undefined,
})

/** Same-project hash changes request verification, then commit locally. */
export function requestProjectTabNavigation(commit: () => void) {
  window.dispatchEvent(new CustomEvent(NAVIGATE, { detail: commit }))
}

/** Confirmed handle/authority writes invalidate browsing evidence, never a transaction journal. */
export function invalidateProjectRoute() {
  if (typeof window !== 'undefined') window.dispatchEvent?.(new Event(INVALIDATE))
}

function currentHandle() {
  const segment = projectRouteSegmentFromPathname(window.location.pathname)
  return segment?.startsWith('@') ? segment : null
}

/** Owns the alias lease above the router cache; only interactions cause revalidation. */
export function ProjectRouteProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [snapshot, setSnapshot] = useState<ProjectRouteSnapshot | null>(null)
  const [state, setState] = useState<NavigationState>('ready')
  const [error, setError] = useState<string | null>(null)
  const rendered = useRef<ProjectRouteSnapshot | null>(null)
  const renderedAlias = useRef<string | null>(null)
  const serverIdentity = useRef<string | null>(null)
  const replacingDocument = useRef(false)
  const generation = useRef(0)
  const registration = useRef(0)
  const pendingCommit = useRef<(() => void) | undefined>(undefined)
  const complete = useCallback(() => {
    setState('ready')
    setError(null)
    const commit = pendingCommit.current
    pendingCommit.current = undefined
    commit?.()
  }, [])

  const readVerified = useCallback(async (handle: string, force = false) => {
    const queryKey = projectRouteQueryKey(handle)
    const cached = queryClient.getQueryData<ProjectRouteSnapshot>(queryKey)
    const invalidated = queryClient.getQueryState(queryKey)?.isInvalidated
    if (!force && !invalidated && cached && projectRouteIsFresh(cached)) return cached
    if (force || invalidated) queryClient.removeQueries({ queryKey, exact: true })
    return await queryClient.fetchQuery({
      queryKey,
      staleTime: 0,
      retry: false,
      gcTime: 60_000,
      queryFn: async ({ signal }) => {
        const read = async (fresh: boolean) => {
          const requestStartedAt = Date.now()
          const response = await fetch(`/api/project-route?segment=${encodeURIComponent(handle)}${fresh ? '&fresh=1' : ''}`, {
            signal, cache: 'no-store',
          })
          if (!response.ok) throw new Error('Project link could not be verified. Try again.')
          return { value: await response.json() as unknown, requestStartedAt }
        }
        const first = await read(force || !!invalidated)
        // A server lease can expire in transit. Retry once instead of extending its age.
        try { return readProjectRouteSnapshot(first.value, first.requestStartedAt) }
        catch {
          const fresh = await read(true)
          return readProjectRouteSnapshot(fresh.value, fresh.requestStartedAt)
        }
      },
    })
  }, [queryClient])

  const verify = useCallback(async (commit?: () => void, force = false) => {
    if (replacingDocument.current) return
    const handle = currentHandle()
    if (!handle) {
      generation.current++
      pendingCommit.current = undefined
      complete()
      commit?.()
      return
    }
    const attempt = ++generation.current
    if (commit) pendingCommit.current = commit
    const queryKey = projectRouteQueryKey(handle)
    const cached = queryClient.getQueryData<ProjectRouteSnapshot>(queryKey)
    const invalidated = queryClient.getQueryState(queryKey)?.isInvalidated
    if (!force && !invalidated && cached && projectRouteIsFresh(cached) &&
      rendered.current && renderedAlias.current === handle &&
      projectRouteIdentity(cached) === projectRouteIdentity(rendered.current) &&
      serverIdentity.current === projectRouteIdentity(cached)) {
      complete()
      return
    }
    setState(rendered.current && serverIdentity.current !== projectRouteIdentity(rendered.current) ? 'mismatched' : 'checking')
    setError(null)
    try {
      const result = await readVerified(handle, force)
      if (attempt !== generation.current || currentHandle() !== handle) return
      if (!projectRouteIsFresh(result)) throw new Error('Project link verification expired. Try again.')
      const displayed = rendered.current
      // A route being mounted will register before it can use this proof.
      // Absence of a page is not evidence of a changed alias binding.
      if (!displayed || renderedAlias.current !== handle) return
      if (projectRouteIdentity(result) === projectRouteIdentity(displayed)) {
        if (serverIdentity.current !== projectRouteIdentity(result)) {
          throw new Error('The project page and verified link disagree. Try again to update the page.')
        }
        rendered.current = result
        setSnapshot(result)
        complete()
        return
      }
      // A proven rebind is a different project, not a local view change.
      // Discard this document so late financial preparations and global
      // reviews cannot continue under its replacement identity.
      replacingDocument.current = true
      setState('replacing')
      const commitView = pendingCommit.current
      pendingCommit.current = undefined
      commitView?.()
      window.location.reload()
    } catch (cause) {
      if (attempt !== generation.current || currentHandle() !== handle) return
      pendingCommit.current = undefined
      setError(cause instanceof Error ? cause.message : 'Project link could not be verified.')
      setState('error')
    }
  }, [complete, queryClient, readVerified])

  const register = useCallback((serverSnapshot: ProjectRouteSnapshot) => {
    if (replacingDocument.current) return () => undefined
    // RSC delivery has no trustworthy browser/server clock mapping. Verify
    // once on alias mount, then reuse only endpoint leases with measured RTT.
    const alias = currentHandle()
    const cached = alias
      ? queryClient.getQueryData<ProjectRouteSnapshot>(projectRouteQueryKey(alias))
      : undefined
    const next = cached && projectRouteIsFresh(cached) &&
      projectRouteIdentity(cached) === projectRouteIdentity(serverSnapshot)
      ? cached : { ...serverSnapshot, checkedAt: 0, serverNow: 0 }
    const owner = ++registration.current
    const previous = rendered.current
    serverIdentity.current = projectRouteIdentity(next)
    const sameAliasChanged = !!alias && previous && renderedAlias.current === alias &&
      projectRouteIdentity(previous) !== serverIdentity.current
    if (previous && renderedAlias.current !== alias) {
      generation.current++
      pendingCommit.current = undefined
      complete()
    }
    // A same-alias server refresh is a candidate, not permission to replace
    // the identity whose actions this document already prepared.
    renderedAlias.current = alias
    rendered.current = sameAliasChanged ? previous : next
    setSnapshot(rendered.current)
    if (sameAliasChanged || (alias && !projectRouteIsFresh(next))) {
      void verify()
    } else {
      generation.current++
      complete()
    }
    return () => {
      if (registration.current !== owner) return
      setSnapshot(null)
      if (currentHandle() !== alias) {
        generation.current++
        pendingCommit.current = undefined
        complete()
        if (alias) void queryClient.cancelQueries({ queryKey: projectRouteQueryKey(alias), exact: true })
      }
    }
  }, [complete, queryClient, verify])

  useEffect(() => {
    const navigate = (event: Event) => { void verify((event as CustomEvent<() => void>).detail) }
    const revalidate = () => { if (currentHandle()) void verify() }
    const focused = () => {
      if (typeof document === 'undefined' || !document.querySelector('dialog[open]')) revalidate()
    }
    const restored = (event: PageTransitionEvent) => { if (event.persisted) revalidate() }
    const invalidate = () => {
      queryClient.removeQueries({ queryKey: ['projectRoute'] })
      if (currentHandle()) void verify(undefined, true)
    }
    window.addEventListener(NAVIGATE, navigate)
    window.addEventListener(INVALIDATE, invalidate)
    window.addEventListener('hashchange', revalidate)
    window.addEventListener('popstate', revalidate)
    window.addEventListener('pageshow', restored)
    window.addEventListener('focus', focused)
    return () => {
      // This is a request generation counter, not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      void queryClient.cancelQueries({ queryKey: ['projectRoute'] })
      window.removeEventListener(NAVIGATE, navigate)
      window.removeEventListener(INVALIDATE, invalidate)
      window.removeEventListener('hashchange', revalidate)
      window.removeEventListener('popstate', revalidate)
      window.removeEventListener('pageshow', restored)
      window.removeEventListener('focus', focused)
    }
  }, [queryClient, verify])

  const scope = useMemo<ProjectReviewScope | null>(() => {
    if (!snapshot || state === 'error' || state === 'replacing' || state === 'mismatched') return null
    const identity = projectRouteIdentity(snapshot)
    const alias = renderedAlias.current
    return {
      identity,
      verify: async () => {
        const proofGeneration = generation.current
        const matches = () => !replacingDocument.current && rendered.current && projectRouteIdentity(rendered.current) === identity && serverIdentity.current === identity && currentHandle() === alias
        if (!matches()) return false
        if (!alias) return true
        try {
          const verified = await readVerified(alias)
          if (!matches()) return false
          if (projectRouteIdentity(verified) !== identity || !projectRouteIsFresh(verified)) {
            void verify()
            return false
          }
          rendered.current = verified
          setSnapshot(verified)
          return true
        } catch {
          if (!matches() || proofGeneration !== generation.current) return false
          pendingCommit.current = undefined
          setError('Project link could not be verified. Try again.')
          setState('error')
          return false
        }
      },
    }
  }, [readVerified, snapshot, state, verify])

  const value = useMemo(() => ({
    route: state === 'ready' && snapshot ? {
      chainId: snapshot.chainId, projectId: Number(snapshot.projectId), handle: snapshot.handle,
    } : null,
    scope, state, error, register, retry: () => {
      if (rendered.current && serverIdentity.current !== projectRouteIdentity(rendered.current)) router.refresh()
      void verify(undefined, true)
    },
  }), [error, register, router, scope, snapshot, state, verify])
  return <ProjectRouteBlockedContext.Provider value={state !== 'ready'}>
    <ProjectRouteContext.Provider value={value}>{children}</ProjectRouteContext.Provider>
  </ProjectRouteBlockedContext.Provider>
}

export function useResolvedProjectRoute() {
  return useContext(ProjectRouteContext).route
}

export function useProjectReviewScope() {
  return useContext(ProjectRouteContext).scope
}

/** Preserve same-project UI while verifying; withhold actions until evidence recovers. */
export function ProjectRouteBoundary({ snapshot, children }: PropsWithChildren<{ snapshot: ProjectRouteSnapshot }>) {
  const { state, error, register, retry, scope } = useContext(ProjectRouteContext)
  useLayoutEffect(() => register(snapshot), [register, snapshot])
  const blocked = state !== 'ready' || !!(snapshot.handle && scope && scope.identity !== projectRouteIdentity(snapshot))
  return <>
    {blocked && <div className="mx-auto max-w-6xl px-4 py-8" role="status">
      <p>{error ?? 'Checking the project link…'}</p>
      {state === 'error' && <button type="button" className="mt-3 underline" onClick={retry}>Try again</button>}
    </div>}
    <div key={projectRouteIdentity(snapshot)} hidden={blocked} inert={blocked}>
      {children}
    </div>
  </>
}

/** Legacy layout readers still synchronize through the same route owner. */
export function ProjectRouteSync({ route }: { route: ResolvedProjectRoute }) {
  const { register } = useContext(ProjectRouteContext)
  const snapshot = useMemo(() => ({ ...route, checkedAt: 0, serverNow: 0 }), [route])
  useLayoutEffect(() => register(snapshot), [register, snapshot])
  return null
}
