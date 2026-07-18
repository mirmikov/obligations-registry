import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { closePresence, request } from './api'

function presenceSession() {
  let id = sessionStorage.getItem('registry_presence_session')
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
    sessionStorage.setItem('registry_presence_session', id)
  }
  return id
}

export default function usePresence(initialLocation) {
  const sessionId = useMemo(presenceSession, [])
  const locationRef = useRef({ page: 'registry', page_label: 'Реестр обязательств', mode: 'view', ...initialLocation })
  const [sessions, setSessions] = useState([])

  const heartbeat = useCallback(() => request('/api/presence', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, ...locationRef.current }),
  }).then(entry => {
    if (entry) setSessions(current => [...current.filter(item => item.session_id !== sessionId), entry])
    return entry
  }).catch(() => {}), [sessionId])

  const refresh = useCallback(() => request('/api/presence')
    .then(result => setSessions(result.items || []))
    .catch(() => {}), [])

  const updateLocation = useCallback(next => {
    locationRef.current = { ...locationRef.current, ...next }
    heartbeat()
  }, [heartbeat])

  useEffect(() => {
    heartbeat(); refresh()
    const heartbeatTimer = window.setInterval(heartbeat, 5000)
    const refreshTimer = window.setInterval(refresh, 2500)
    const onVisibility = () => { if (document.visibilityState === 'visible') { heartbeat(); refresh() } }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(heartbeatTimer); window.clearInterval(refreshTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      closePresence(sessionId)
    }
  }, [heartbeat, refresh, sessionId])

  const activeUsers = useMemo(() => {
    const byUser = new Map()
    for (const entry of sessions.filter(item => item.page === 'registry')) {
      const current = byUser.get(entry.user_id)
      const editingWins = entry.mode === 'edit' && current?.mode !== 'edit'
      const newerSameMode = entry.mode === current?.mode && new Date(entry.updated_at) > new Date(current.updated_at)
      if (!current || editingWins || newerSameMode) byUser.set(entry.user_id, entry)
    }
    return [...byUser.values()]
  }, [sessions])

  return { activeUsers, updateLocation, sessionId }
}
