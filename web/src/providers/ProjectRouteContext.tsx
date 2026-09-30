'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { projectRouteSegmentFromPathname } from '@/lib/project-handles'

export type ResolvedProjectRoute = {
  chainId: JBChainId
  projectId: number
  handle: string | null
}

type ProjectRouteContextValue = {
  route: ResolvedProjectRoute | null
  setRoute: (route: ResolvedProjectRoute | null) => void
}

const ProjectRouteContext = createContext<ProjectRouteContextValue>({
  route: null,
  setRoute: () => undefined,
})

/** Makes a server-resolved `/@handle` identity available to layout clients. */
export function ProjectRouteProvider({ children }: PropsWithChildren) {
  const [route, setRoute] = useState<ResolvedProjectRoute | null>(null)
  const value = useMemo(() => ({ route, setRoute }), [route])

  useEffect(() => {
    const reloadIfHandleRoute = () => {
      const segment = projectRouteSegmentFromPathname(window.location.pathname)
      if (segment?.startsWith('@')) window.location.reload()
    }
    const restoreFromBfcache = (event: PageTransitionEvent) => {
      if (event.persisted) reloadIfHandleRoute()
    }

    // This provider lives above the route cache. Browser Back/Forward can
    // restore an old @handle RSC tree (or a whole BFCache document) after ENS
    // has rebound, so every history restoration into an alias must re-enter
    // the server resolver. Ordinary loads/pageshow events do not reload.
    window.addEventListener('popstate', reloadIfHandleRoute)
    window.addEventListener('pageshow', restoreFromBfcache)
    return () => {
      window.removeEventListener('popstate', reloadIfHandleRoute)
      window.removeEventListener('pageshow', restoreFromBfcache)
    }
  }, [])

  return (
    <ProjectRouteContext.Provider value={value}>
      {children}
    </ProjectRouteContext.Provider>
  )
}

export function useResolvedProjectRoute() {
  return useContext(ProjectRouteContext).route
}

/** Synchronizes the authoritative server resolution while a project is open. */
export function ProjectRouteSync({ route }: { route: ResolvedProjectRoute }) {
  const { setRoute } = useContext(ProjectRouteContext)
  useEffect(() => {
    setRoute(route)
    return () => setRoute(null)
  }, [route, setRoute])
  return null
}
