const supportedPages = new Set(['dashboard', 'my-invoices', 'executive', 'registry', 'credits-leasing', 'payments', 'chat', 'references', 'users', 'audit'])

export function readDesktopNotificationTarget(search = '') {
  const params = new URLSearchParams(search)
  const page = params.get('page') || ''
  if (!supportedPages.has(page)) return null
  const rawConversation = params.get('conversation')
  const conversationID = rawConversation && /^\d+$/.test(rawConversation) ? Number(rawConversation) : null
  const rawAIScanBatch = params.get('ai_scan_batch') || ''
  const aiScanBatch = page === 'registry' && /^[a-f0-9]{48}$/.test(rawAIScanBatch) ? rawAIScanBatch : null
  return { page, conversationID: page === 'chat' && Number.isSafeInteger(conversationID) && conversationID > 0 ? conversationID : null, aiScanBatch }
}

export function clearDesktopNotificationTarget(location = window.location) {
  const params = new URLSearchParams(location.search)
  params.delete('page')
  params.delete('conversation')
  params.delete('ai_scan_batch')
  const query = params.toString()
  window.history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`)
}
