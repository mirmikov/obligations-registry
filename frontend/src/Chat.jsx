import { useEffect, useMemo, useRef, useState } from 'react'
import { BellRing, Check, ChevronLeft, MessageCircle, Plus, Search, Send, UserPlus, Users, X } from 'lucide-react'
import { request, requestBlob } from './api'
import { roleLabel } from './App'

export default function Chat({ user, notify, compact = false, initialConversationID = null, notificationPermission, onEnableNotifications }) {
  const [contacts, setContacts] = useState([])
  const [conversations, setConversations] = useState([])
  const [selectedID, setSelectedID] = useState(null)
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [draftImage, setDraftImage] = useState(null)
  const [viewingImage, setViewingImage] = useState(null)
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef(null)
  const draftImageRef = useRef(null)
  const lastImagePasteRef = useRef(0)

  const loadContacts = () => request('/api/chat/users').then(setContacts).catch(error => notify(error.message, 'error'))
  const loadConversations = () => request('/api/chat/conversations').then(setConversations).catch(error => notify(error.message, 'error'))

  useEffect(() => {
    loadContacts(); loadConversations()
    const timer = window.setInterval(() => { loadContacts(); loadConversations() }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => { if (initialConversationID) setSelectedID(initialConversationID) }, [initialConversationID])

  useEffect(() => {
    if (!conversations.length) { setSelectedID(null); return }
    if (selectedID && !conversations.some(item => item.id === selectedID)) setSelectedID(null)
    else if (!compact && !selectedID) setSelectedID(conversations[0].id)
  }, [conversations, selectedID, compact])

  useEffect(() => {
    if (!selectedID) { setMessages([]); return undefined }
    let active = true
    const load = () => request(`/api/chat/conversations/${selectedID}/messages`).then(items => { if (active) setMessages(items) }).catch(error => notify(error.message, 'error'))
    load()
    const timer = window.setInterval(load, 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedID])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, selectedID])
  useEffect(() => { draftImageRef.current = draftImage }, [draftImage])
  useEffect(() => () => { if (draftImageRef.current?.url) URL.revokeObjectURL(draftImageRef.current.url) }, [])
  useEffect(() => {
    setViewingImage(null)
    setDraftImage(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })
  }, [selectedID])
  useEffect(() => {
    if (!viewingImage) return undefined
    const close = event => { if (event.key === 'Escape') setViewingImage(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [viewingImage])

  const selected = conversations.find(item => item.id === selectedID)
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('ru-RU')
    if (!needle) return conversations
    return conversations.filter(item => `${item.title} ${item.last_message} ${item.members.map(member => member.name).join(' ')}`.toLocaleLowerCase('ru-RU').includes(needle))
  }, [conversations, search])

  const send = async event => {
    event.preventDefault()
    const body = draft.trim()
    if ((!body && !draftImage) || !selectedID || sending) return
    setSending(true)
    try {
      let payload
      if (draftImage) {
        payload = new FormData()
        payload.append('body', body)
        payload.append('image', draftImage.file, draftImage.file.name || 'clipboard-image.png')
      }
      const message = await request(`/api/chat/conversations/${selectedID}/messages`, { method: 'POST', body: payload || JSON.stringify({ body }) })
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message])
      setDraft('')
      setDraftImage(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })
      loadConversations()
    } catch (error) { notify(error.message, 'error') } finally { setSending(false) }
  }

  const pasteImage = event => {
    const item = [...(event.clipboardData?.items || [])].find(value => value.kind === 'file' && value.type.startsWith('image/'))
    if (!item) return
    const file = item.getAsFile()
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { notify('Поддерживаются PNG, JPEG, GIF и WebP', 'error'); return }
    if (file.size > 8 * 1024 * 1024) { notify('Изображение должно быть не больше 8 МБ', 'error'); return }
    event.preventDefault()
    lastImagePasteRef.current = Date.now()
    setDraftImage(current => {
      if (current?.url) URL.revokeObjectURL(current.url)
      return { file, url: URL.createObjectURL(file) }
    })
  }

  const composerKeyDown = event => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    // Some clipboard managers emit an extra key event after paste. The image
    // must stay in preview until the user explicitly presses Enter or Send.
    if (Date.now() - lastImagePasteRef.current < 300) return
    event.currentTarget.form?.requestSubmit()
  }

  const conversationCreated = async id => {
    setCreating(false)
    await loadConversations()
    setSelectedID(id)
  }

  return <div className={`chat-page ${compact ? 'chat-page-compact' : ''} ${selected ? 'has-room' : ''}`}>
    <aside className="chat-list-panel">
      <header><div><p>Команда</p><h1>Сообщения</h1></div><div className="chat-list-actions">{notificationPermission === 'default' && <button type="button" className="chat-enable-bell" onClick={onEnableNotifications} aria-label="Включить уведомления" title="Включить уведомления"><BellRing size={17}/></button>}<button type="button" onClick={() => setCreating(true)} aria-label="Начать новый чат" title="Начать новый чат"><Plus size={19}/></button></div></header>
      <label className="chat-search"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск диалогов"/></label>
      <div className="chat-conversations">
        {filtered.map(item => <button type="button" key={item.id} className={item.id === selectedID ? 'active' : ''} onClick={() => setSelectedID(item.id)}>
          <ConversationAvatar item={item} currentUser={user}/>
          <span className="chat-conversation-copy"><strong>{item.title}</strong><small>{item.last_message ? `${item.last_sender}: ${item.last_message}` : item.kind === 'group' ? `${item.members.length} участников` : 'Начните общение'}</small></span>
          <span className="chat-conversation-meta"><time>{chatListTime(item.last_at)}</time>{item.unread > 0 && <b>{item.unread > 99 ? '99+' : item.unread}</b>}</span>
        </button>)}
        {!filtered.length && <div className="chat-list-empty"><MessageCircle size={25}/><strong>{search ? 'Ничего не найдено' : 'Диалогов пока нет'}</strong><span>{search ? 'Попробуйте другой запрос' : 'Напишите коллеге или создайте группу'}</span></div>}
      </div>
    </aside>

    <main className="chat-room">
      {selected ? <>
        <header className="chat-room-head">{compact && <button type="button" className="chat-room-back" onClick={() => setSelectedID(null)} aria-label="Назад к диалогам"><ChevronLeft size={19}/></button>}<ConversationAvatar item={selected} currentUser={user}/><div><strong>{selected.title}</strong><span>{conversationSubtitle(selected, user)}</span></div></header>
        <div className="chat-messages">
          {!messages.length && <div className="chat-welcome"><div><MessageCircle size={30}/></div><strong>Начните разговор</strong><span>Сообщения доступны только участникам этого диалога.</span></div>}
          {messages.map((message, index) => {
            const mine = message.sender_id === user.id
            const newGroup = index === 0 || messages[index - 1].sender_id !== message.sender_id || messages[index - 1].created_at.slice(0, 10) !== message.created_at.slice(0, 10)
            const newDay = index === 0 || messages[index - 1].created_at.slice(0, 10) !== message.created_at.slice(0, 10)
            return <div key={message.id}>{newDay && <div className="chat-day"><span>{chatDay(message.created_at)}</span></div>}<div className={`chat-message ${mine ? 'mine' : ''} ${newGroup ? 'new-group' : ''}`}>
              {!mine && newGroup && <span className="chat-message-avatar">{initials(message.sender_name)}</span>}
              <div className={`chat-bubble ${message.image_url ? 'has-image' : ''}`}>{!mine && newGroup && <strong>{message.sender_name}</strong>}{message.image_url && <ChatImage path={message.image_url} alt={`Изображение от ${message.sender_name}`} onOpen={() => setViewingImage({ path: message.image_url, alt: `Изображение от ${message.sender_name}` })}/>} {message.body && <p>{message.body}</p>}<time>{chatClock(message.created_at)}</time></div>
            </div></div>
          })}
          <div ref={messagesEndRef}/>
        </div>
        <form className={`chat-composer ${draftImage ? 'has-image' : ''}`} onSubmit={send}>
          {draftImage && <div className="chat-composer-preview"><img src={draftImage.url} alt="Изображение перед отправкой"/><span><strong>Изображение готово</strong><small>{formatFileSize(draftImage.file.size)}</small></span><button type="button" onClick={() => setDraftImage(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })} aria-label="Удалить изображение" title="Удалить изображение"><X size={16}/></button></div>}
          <div className="chat-composer-main"><textarea value={draft} onChange={event => setDraft(event.target.value)} onPaste={pasteImage} onKeyDown={composerKeyDown} maxLength={4000} rows={1} placeholder="Напишите сообщение или вставьте изображение…"/><button type="submit" disabled={(!draft.trim() && !draftImage) || sending} aria-label="Отправить сообщение"><Send size={19}/></button></div>
        </form>
      </> : <div className="chat-no-room"><div><MessageCircle size={34}/></div><h2>Корпоративный чат</h2><p>Общайтесь с коллегами лично или создавайте группы для совместной работы.</p><button type="button" className="primary" onClick={() => setCreating(true)}><UserPlus size={17}/>Начать общение</button></div>}
    </main>
    {creating && <NewChatModal currentUser={user} contacts={contacts} onClose={() => setCreating(false)} onCreated={conversationCreated} notify={notify}/>}
    {viewingImage && <div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label="Просмотр изображения" onClick={() => setViewingImage(null)}><button type="button" onClick={() => setViewingImage(null)} aria-label="Закрыть изображение" title="Закрыть"><X size={25}/></button><ChatImage path={viewingImage.path} alt={viewingImage.alt} fullscreen onClick={event => event.stopPropagation()}/></div>}
  </div>
}

function ChatImage({ path, alt, onOpen, fullscreen = false, onClick }) {
  const [source, setSource] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let objectURL = ''
    setSource(''); setFailed(false)
    requestBlob(path).then(blob => {
      if (!active) return
      objectURL = URL.createObjectURL(blob)
      setSource(objectURL)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [path])
  if (failed) return <span className="chat-image-error">Не удалось загрузить изображение</span>
  if (!source) return <span className={`chat-image-loading ${fullscreen ? 'fullscreen' : ''}`}>Загружаем изображение…</span>
  if (fullscreen) return <img className="chat-image-full" src={source} alt={alt} onClick={onClick}/>
  return <button type="button" className="chat-message-image" onClick={onOpen} aria-label="Открыть изображение на весь экран"><img src={source} alt={alt}/></button>
}

function NewChatModal({ currentUser, contacts, onClose, onCreated, notify }) {
  const [mode, setMode] = useState('direct')
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState([])
  const [saving, setSaving] = useState(false)
  const available = contacts.filter(item => item.id !== currentUser.id && `${item.name} ${item.email}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU')))

  const openDirect = async contact => {
    if (saving) return
    setSaving(true)
    try { const result = await request('/api/chat/direct', { method: 'POST', body: JSON.stringify({ user_id: contact.id }) }); await onCreated(result.id) }
    catch (error) { notify(error.message, 'error'); setSaving(false) }
  }
  const createGroup = async event => {
    event.preventDefault()
    if (!name.trim() || !selected.length || saving) return
    setSaving(true)
    try { const result = await request('/api/chat/groups', { method: 'POST', body: JSON.stringify({ name: name.trim(), member_ids: selected }) }); await onCreated(result.id) }
    catch (error) { notify(error.message, 'error'); setSaving(false) }
  }
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])

  return <div className="modal-backdrop"><div className="modal chat-new-modal">
    <div className="modal-head"><div><p className="eyebrow">Новое общение</p><h2>{mode === 'direct' ? 'Личное сообщение' : 'Новая группа'}</h2></div><button type="button" onClick={onClose}><X/></button></div>
    <div className="chat-create-tabs"><button className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}><MessageCircle size={16}/>Личный чат</button><button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}><Users size={16}/>Группа</button></div>
    <form onSubmit={createGroup}>
      {mode === 'group' && <label className="field chat-group-name"><span>Название группы</span><input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Например, Бухгалтерия"/></label>}
      <label className="chat-search modal-search"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти пользователя"/></label>
      <div className="chat-contact-list">{available.map(contact => <button type="button" key={contact.id} className={selected.includes(contact.id) ? 'selected' : ''} onClick={() => mode === 'direct' ? openDirect(contact) : toggle(contact.id)} disabled={saving}>
        <span className="contact-avatar">{initials(contact.name)}<i className={contact.online ? 'online' : ''}/></span><span><strong>{contact.name}</strong><small>{contact.email} · {roleLabel(contact.role)}</small></span>{mode === 'group' && <em>{selected.includes(contact.id) && <Check size={15}/>}</em>}
      </button>)}</div>
      {mode === 'group' && <div className="modal-footer"><span>{selected.length ? `Выбрано: ${selected.length}` : 'Выберите участников'}</span><button type="submit" className="primary" disabled={!name.trim() || !selected.length || saving}>{saving ? 'Создаём…' : 'Создать группу'}</button></div>}
    </form>
  </div></div>
}

function ConversationAvatar({ item, currentUser }) {
  if (item.kind === 'group') return <span className="conversation-avatar group"><Users size={18}/></span>
  const other = item.members.find(member => member.id !== currentUser.id)
  return <span className="conversation-avatar">{initials(other?.name || item.title)}</span>
}
function conversationSubtitle(item, user) { if (item.kind === 'group') return `${item.members.length} участников · ${item.members.map(member => member.id === user.id ? 'Вы' : member.name).join(', ')}`; const other = item.members.find(member => member.id !== user.id); return other ? `${other.email} · ${roleLabel(other.role)}` : 'Личный диалог' }
function initials(value = '') { return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '•' }
function parseChatDate(value) { return value ? new Date(value.replace(' ', 'T')) : null }
function chatClock(value) { const date = parseChatDate(value); return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '' }
function chatDay(value) { const date = parseChatDate(value); if (!date || Number.isNaN(date.getTime())) return ''; const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const key = date.toDateString(); if (key === today.toDateString()) return 'Сегодня'; if (key === yesterday.toDateString()) return 'Вчера'; return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) }
function chatListTime(value) { const date = parseChatDate(value); if (!date || Number.isNaN(date.getTime())) return ''; const today = new Date(); return date.toDateString() === today.toDateString() ? chatClock(value) : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) }
function formatFileSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` }
