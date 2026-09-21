import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  loadWorkspacePreferences,
  saveWorkspacePreferences,
} from '../lib/workspacePreferences'

const WorkspacePreferencesContext=createContext(null)

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null }
}

function fallbackWorkspace(user) {
  return (
    user?.user_metadata?.company ||
    user?.user_metadata?.organization ||
    user?.user_metadata?.workspace ||
    'Workspace'
  )
}

export function WorkspacePreferencesProvider({ children }) {
  const { user } = useAuth()
  const [preferences,setPreferences]=useState({
    ...DEFAULT_WORKSPACE_PREFERENCES,
    workspace_name:fallbackWorkspace(user),
    timezone:browserTimezone(),
    exists:false,
  })
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')

  async function reload() {
    if(!user?.id) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const loaded=await loadWorkspacePreferences({database:supabase,userId:user.id})
      setPreferences({
        ...loaded,
        workspace_name:loaded.workspace_name || fallbackWorkspace(user),
        timezone:loaded.timezone || browserTimezone(),
      })
      setError('')
    } catch(loadError) {
      setPreferences((current)=>({
        ...current,
        workspace_name:current.workspace_name || fallbackWorkspace(user),
        timezone:current.timezone || browserTimezone(),
      }))
      setError(loadError?.message || 'Workspace preferences are unavailable.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(()=>{
    reload()
  },[user?.id])

  async function save(next) {
    if(!user?.id) throw new Error('Sign in before saving workspace preferences.')
    const saved=await saveWorkspacePreferences({
      database:supabase,
      userId:user.id,
      preferences:next,
    })
    const merged={
      ...DEFAULT_WORKSPACE_PREFERENCES,
      ...saved,
      workspace_name:saved.workspace_name || fallbackWorkspace(user),
      timezone:saved.timezone || browserTimezone(),
      exists:true,
    }
    setPreferences(merged)
    setError('')
    return merged
  }

  const value=useMemo(()=>({
    preferences,
    setPreferences,
    loading,
    error,
    reload,
    save,
  }),[preferences,loading,error])

  return <WorkspacePreferencesContext.Provider value={value}>{children}</WorkspacePreferencesContext.Provider>
}

export function useWorkspacePreferences() {
  const value=useContext(WorkspacePreferencesContext)
  if(!value) throw new Error('useWorkspacePreferences must be used inside WorkspacePreferencesProvider')
  return value
}
