import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from './api'

function currentPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export default function useChatNotifications({ user, page, onOpenChat, notify }) {
  const [permission, setPermission] = useState(currentPermission)
  const [unread, setUnread] = useState(0)
  const previousRef = useRef(new Map())
  const initializedRef = useRef(false)
  const pageRef = useRef(page)
  const openChatRef = useRef(onOpenChat)

  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { openChatRef.current = onOpenChat }, [onOpenChat])

  useEffect(() => {
    if (!user) { setUnread(0); previousRef.current = new Map(); initializedRef.current = false; return undefined }
    let active = true
    const refresh = async () => {
      try {
        const conversations = await request('/api/chat/conversations')
        if (!active) return
        const next = new Map(conversations.map(item => [item.id, item.unread || 0]))
        setUnread(conversations.reduce((total, item) => total + Number(item.unread || 0), 0))
        if (initializedRef.current && permission === 'granted' && pageRef.current !== 'chat') {
          for (const item of conversations) {
            const before = previousRef.current.get(item.id) || 0
            if (item.unread > before) showChatNotification(item, openChatRef)
          }
        }
        previousRef.current = next
        initializedRef.current = true
      } catch { /* общий интерфейс не должен ломаться из-за проверки уведомлений */ }
    }
    refresh()
    const timer = window.setInterval(refresh, 7000)
    return () => { active = false; window.clearInterval(timer) }
  }, [user?.id, permission])

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

  return { permission, unread, requestPermission }
}

function showChatNotification(conversation, openChatRef) {
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
      openChatRef.current?.()
      notification.close()
    }
  } catch { /* разрешение могло быть отозвано между проверкой и показом */ }
}
