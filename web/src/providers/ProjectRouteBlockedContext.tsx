'use client'

import { createContext, useContext } from 'react'

/** Modal presentation needs only this state, not the alias navigation controller. */
export const ProjectRouteBlockedContext = createContext(false)

export function useProjectRouteBlocked() {
  return useContext(ProjectRouteBlockedContext)
}
