export const CHAT_READ_EVENT = 'registry:chat-read'

export function clearConversationUnread(conversations, conversationID) {
  if (conversationID == null) return conversations
  const target = String(conversationID)
  let changed = false
  const next = conversations.map(item => {
    if (String(item.id) !== target || Number(item.unread || 0) === 0) return item
    changed = true
    return { ...item, unread: 0 }
  })
  return changed ? next : conversations
}

export function takeConversationUnread(unreadByConversation, conversationID) {
  const target = String(conversationID)
  const key = [...unreadByConversation.keys()].find(item => String(item) === target)
  if (key == null) return 0
  const previous = Number(unreadByConversation.get(key) || 0)
  unreadByConversation.set(key, 0)
  return previous
}

export function normalizeUnreadSnapshot(conversations, suppressedConversationIDs) {
  const unreadByConversation = new Map()
  let total = 0
  for (const item of conversations) {
    const key = String(item.id)
    let count = Number(item.unread || 0)
    if (suppressedConversationIDs.has(key)) {
      const readMarker = suppressedConversationIDs instanceof Map ? suppressedConversationIDs.get(key) : ''
      if (count === 0) suppressedConversationIDs.delete(key)
      else if (readMarker && readMarker !== conversationMarker(item)) suppressedConversationIDs.delete(key)
      else count = 0
    }
    unreadByConversation.set(item.id, count)
    total += count
  }
  return { unreadByConversation, total }
}

export function conversationMarker(conversation) {
  return [conversation?.last_at || '', conversation?.last_sender || '', conversation?.last_message || ''].join('\u0000')
}

export function unreadIncreases(conversations, previousUnread, nextUnread) {
  return conversations.flatMap(conversation => {
    const before = unreadForConversation(previousUnread, conversation.id)
    const after = unreadForConversation(nextUnread, conversation.id)
    return after > before ? [{ conversation, added: after - before }] : []
  })
}

function unreadForConversation(unreadByConversation, conversationID) {
  const target = String(conversationID)
  for (const [key, value] of unreadByConversation) {
    if (String(key) === target) return Number(value || 0)
  }
  return 0
}

export function dispatchChatRead(conversationID) {
  if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
  window.dispatchEvent(new window.CustomEvent(CHAT_READ_EVENT, { detail: { conversationID } }))
}
