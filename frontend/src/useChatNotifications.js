import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from './api'
import { CHAT_READ_EVENT, conversationMarker, normalizeUnreadSnapshot, takeConversationUnread, unreadIncreases } from './chatUnread'

function currentPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export default function useChatNotifications({ user, page, onOpenChat, notify }) {
  const [permission, setPermission] = useState(currentPermission)
  const [unread, setUnread] = useState(0)
  const [notices, setNotices] = useState([])
  const previousRef = useRef(new Map())
  const initializedRef = useRef(false)
  const openChatRef = useRef(onOpenChat)
  const noticeTimersRef = useRef(new Map())
  const suppressedReadRef = useRef(new Map())
  const conversationMarkersRef = useRef(new Map())

  useEffect(() => { openChatRef.current = onOpenChat }, [onOpenChat])
  useEffect(() => () => {
    noticeTimersRef.current.forEach(window.clearTimeout)
    noticeTimersRef.current.clear()
  }, [])
  useEffect(() => {
    const conversationRead = event => {
      const conversationID = event.detail?.conversationID
      if (conversationID == null) return
      const key = String(conversationID)
      suppressedReadRef.current.set(key, conversationMarkersRef.current.get(key) || '')
      const previousUnread = takeConversationUnread(previousRef.current, conversationID)
      setUnread(current => Math.max(0, current - previousUnread))
      setNotices(current => current.filter(item => String(item.conversationID) !== String(conversationID)))
      window.clearTimeout(noticeTimersRef.current.get(conversationID))
      noticeTimersRef.current.delete(conversationID)
    }
    window.addEventListener(CHAT_READ_EVENT, conversationRead)
    return () => window.removeEventListener(CHAT_READ_EVENT, conversationRead)
  }, [])
  useEffect(() => {
    if (page !== 'chat') return
    setNotices([])
    noticeTimersRef.current.forEach(window.clearTimeout)
    noticeTimersRef.current.clear()
  }, [page])

  useEffect(() => {
    if (!user) {
      setUnread(0); setNotices([]); previousRef.current = new Map(); initializedRef.current = false
      suppressedReadRef.current = new Map()
      conversationMarkersRef.current = new Map()
      noticeTimersRef.current.forEach(window.clearTimeout)
      noticeTimersRef.current.clear()
      return undefined
    }
    let active = true
    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const conversations = await request('/api/chat/conversations')
        if (!active) return
        const snapshot = normalizeUnreadSnapshot(conversations, suppressedReadRef.current)
        const next = snapshot.unreadByConversation
        conversationMarkersRef.current = new Map(conversations.map(item => [String(item.id), conversationMarker(item)]))
        setUnread(snapshot.total)
        if (initializedRef.current) {
          for (const { conversation, added } of unreadIncreases(conversations, previousRef.current, next)) {
            showSiteNotification(conversation, added, setNotices, noticeTimersRef)
            if (permission === 'granted') showBrowserNotification(conversation, openChatRef)
          }
        }
        previousRef.current = next
        initializedRef.current = true
      } catch { /* общий интерфейс не должен ломаться из-за проверки уведомлений */ }
      finally { refreshing = false }
    }
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refresh() }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [user?.id, permission])

  const dismissNotice = useCallback(conversationID => {
    setNotices(current => current.filter(item => item.conversationID !== conversationID))
    window.clearTimeout(noticeTimersRef.current.get(conversationID))
    noticeTimersRef.current.delete(conversationID)
  }, [])

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      setPermission('unsupported')
      notify('Этот браузер не поддерживает системные уведомления', 'error')
      return 'unsupported'
    }
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result === 'granted') notify('Уведомления о новых сообщениях включены')
      else if (result === 'denied') notify('Уведомления запрещены в настройках браузера', 'error')
      return result
    } catch {
      notify('Не удалось включить уведомления', 'error')
      return Notification.permission
    }
  }, [notify])

  return { permission, unread, notices, dismissNotice, requestPermission }
}

function showSiteNotification(conversation, added, setNotices, noticeTimersRef) {
  const notice = {
    conversationID: conversation.id,
    title: conversation.title,
    sender: conversation.last_sender,
    body: conversation.last_message || 'Новое сообщение',
    added,
    group: conversation.kind === 'group',
  }
  setNotices(current => [notice, ...current.filter(item => item.conversationID !== conversation.id)].slice(0, 4))
  window.clearTimeout(noticeTimersRef.current.get(conversation.id))
  noticeTimersRef.current.set(conversation.id, window.setTimeout(() => {
    setNotices(current => current.filter(item => item.conversationID !== conversation.id))
    noticeTimersRef.current.delete(conversation.id)
  }, 7000))
}

function showBrowserNotification(conversation, openChatRef) {
  try {
    const body = conversation.last_message
      ? `${conversation.last_sender ? `${conversation.last_sender}: ` : ''}${conversation.last_message}`
      : 'Новое сообщение'
    const notification = new Notification(conversation.kind === 'group' ? conversation.title : `Сообщение от ${conversation.title}`, {
      body,
      tag: `registry-chat-${conversation.id}`,
      renotify: true,
    })
    notification.onclick = () => {
      window.focus()
      openChatRef.current?.(conversation.id)
      notification.close()
    }
  } catch { /* разрешение могло быть отозвано между проверкой и показом */ }
}
