const API = import.meta.env?.VITE_API_URL || ''

export async function request(path, options = {}) {
  const token = localStorage.getItem('registry_token')
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API}${path}`, { ...options, headers })
  if (response.status === 401) {
    localStorage.removeItem('registry_token')
    window.dispatchEvent(new Event('registry:logout'))
  }
  if (!response.ok) {
    let message = 'Не удалось выполнить запрос'
    let details = {}
    try { details = await response.json(); message = details.error || message } catch { /* ignore */ }
    const error = new Error(message)
    error.status = response.status
    error.code = details.code || ''
    error.details = details
    throw error
  }
  if (response.status === 204) return null
  return response.json()
}

export async function requestBlob(path) {
  const token = localStorage.getItem('registry_token')
  const response = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (response.status === 401) {
    localStorage.removeItem('registry_token')
    window.dispatchEvent(new Event('registry:logout'))
  }
  if (!response.ok) throw new Error('Не удалось загрузить файл')
  return response.blob()
}

export async function download(path, filename) {
  const token = localStorage.getItem('registry_token')
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error('Не удалось выгрузить файл')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  URL.revokeObjectURL(url)
}

export function closePresence(sessionId) {
  const token = localStorage.getItem('registry_token')
  if (!token || !sessionId) return
  fetch(`${API}/api/presence/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    keepalive: true,
  }).catch(() => {})
}
