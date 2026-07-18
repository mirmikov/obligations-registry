const API = import.meta.env.VITE_API_URL || ''

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
    try { message = (await response.json()).error || message } catch { /* ignore */ }
    throw new Error(message)
  }
  if (response.status === 204) return null
  return response.json()
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
