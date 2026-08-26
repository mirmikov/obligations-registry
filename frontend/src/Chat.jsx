import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BellRing, Building2, Check, ChevronLeft, Download, FileText, Inbox, MailPlus, MessageCircle, Paperclip, Plus, ScanLine, Search, Send, SendHorizontal, UploadCloud, UserPlus, Users, X } from 'lucide-react'
import { request, requestBlob } from './api'
import { roleLabel } from './App'
import { can } from './permissions'
import AIScanModal from './AIScanModal'
import { buildAIScanObligationValues, normalizeAIScanDocumentPages } from './aiScanValues'
import { clearConversationUnread, dispatchChatRead } from './chatUnread'
import { ACCOUNTING_DESCRIPTION_LIMIT, ACCOUNTING_FILE_ACCEPT, ACCOUNTING_SECTION, ACCOUNTING_SUBJECT_LIMIT, conversationsForSection, folderForAccountingConversation, validateAccountingMailDraft } from './accountingMail'
import './accountingMail.css'

const CHAT_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.csv,.txt,.zip'
const CHAT_FILE_LIMIT = 25 * 1024 * 1024

export default function Chat({ user, notify, compact = false, initialConversationID = null, onInitialConversationApplied = () => {}, notificationPermission, onEnableNotifications }) {
  const canSend = can(user, 'chat.send')
  const canCreate = can(user, 'chat.create')
  const canAIScan = can(user, 'registry.ai_scan')
  const canMailInbox = can(user, 'invoice_mail.inbox')
  const canMailSend = can(user, 'invoice_mail.send')
  const [contacts, setContacts] = useState([])
  const [conversations, setConversations] = useState([])
  const [section, setSection] = useState('chats')
  const [accountingFolder, setAccountingFolder] = useState(canMailInbox ? 'inbox' : 'sent')
  const [selectedID, setSelectedID] = useState(null)
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [draftAttachment, setDraftAttachment] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [viewingImage, setViewingImage] = useState(null)
  const [aiScan, setAIScan] = useState(null)
  const [aiSource, setAISource] = useState(null)
  const [references, setReferences] = useState({})
  const [creating, setCreating] = useState(false)
  const [composingAccountingMail, setComposingAccountingMail] = useState(false)
  const [sending, setSending] = useState(false)
  const messagesViewportRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const lastScrolledConversationRef = useRef(null)
  const draftAttachmentRef = useRef(null)
  const fileInputRef = useRef(null)
  const lastImagePasteRef = useRef(0)
  const selectedConversationRef = useRef(null)
  const appliedInitialConversationRef = useRef(null)

  const sectionConversations = useMemo(
    () => conversationsForSection(conversations, section, accountingFolder, user.id),
    [conversations, section, accountingFolder, user.id],
  )

  const loadContacts = () => request('/api/chat/users').then(setContacts).catch(error => notify(error.message, 'error'))
  const loadConversations = () => request('/api/chat/conversations').then(items => {
    const next = clearConversationUnread(items, selectedConversationRef.current)
    setConversations(next)
    return next
  }).catch(error => { notify(error.message, 'error'); return [] })
  const markConversationRead = useCallback(conversationID => {
    if (conversationID == null) return
    setConversations(current => clearConversationUnread(current, conversationID))
    dispatchChatRead(conversationID)
  }, [])
  const selectConversation = useCallback(conversationID => {
    selectedConversationRef.current = conversationID
    setSelectedID(conversationID)
    markConversationRead(conversationID)
  }, [markConversationRead])
  const closeConversation = useCallback(() => {
    selectedConversationRef.current = null
    setSelectedID(null)
  }, [])

  const switchSection = nextSection => {
    if (nextSection === section) return
    closeConversation()
    setSearch('')
    setSection(nextSection)
    if (nextSection === ACCOUNTING_SECTION && !canMailInbox) setAccountingFolder('sent')
  }

  const switchAccountingFolder = nextFolder => {
    if (nextFolder === accountingFolder) return
    closeConversation()
    setSearch('')
    setAccountingFolder(nextFolder)
  }

  useEffect(() => {
    loadContacts(); loadConversations()
    const timer = window.setInterval(() => { loadContacts(); loadConversations() }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => { if (canAIScan) request('/api/references').then(setReferences).catch(error => notify(error.message, 'error')) }, [canAIScan])

  useEffect(() => {
    if (!canMailInbox && accountingFolder === 'inbox') setAccountingFolder('sent')
  }, [canMailInbox, accountingFolder])

  useEffect(() => {
    if (!initialConversationID) { appliedInitialConversationRef.current = null; return }
    if (String(appliedInitialConversationRef.current) === String(initialConversationID)) return
    const target = conversations.find(item => String(item.id) === String(initialConversationID))
    if (!target) return
    if (target.category === ACCOUNTING_SECTION) {
      setSection(ACCOUNTING_SECTION)
      setAccountingFolder(folderForAccountingConversation(target, user.id, canMailInbox))
    } else setSection('chats')
    appliedInitialConversationRef.current = initialConversationID
    selectConversation(target.id)
    onInitialConversationApplied()
  }, [initialConversationID, conversations, user.id, canMailInbox, selectConversation])

  useEffect(() => {
    if (initialConversationID && String(appliedInitialConversationRef.current) === String(initialConversationID) && String(selectedConversationRef.current) === String(initialConversationID)) return
    if (!sectionConversations.length) { closeConversation(); return }
    const selectedVisible = selectedID && sectionConversations.some(item => String(item.id) === String(selectedID))
    if (!selectedVisible && !compact) selectConversation(sectionConversations[0].id)
    else if (!selectedVisible) closeConversation()
  }, [sectionConversations, selectedID, compact, initialConversationID, closeConversation, selectConversation])

  useEffect(() => {
    if (!selectedID) { setMessages([]); return undefined }
    let active = true
    markConversationRead(selectedID)
    request(`/api/chat/conversations/${selectedID}/read`, { method: 'POST' }).then(() => { if (active) markConversationRead(selectedID) }).catch(error => notify(error.message, 'error'))
    const load = () => request(`/api/chat/conversations/${selectedID}/messages`).then(items => { if (active) { setMessages(items); markConversationRead(selectedID) } }).catch(error => notify(error.message, 'error'))
    load()
    const timer = window.setInterval(load, 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedID, markConversationRead])

  useEffect(() => {
    const viewport = messagesViewportRef.current
    if (!viewport || !selectedID) return undefined
    const conversationChanged = lastScrolledConversationRef.current !== selectedID
    lastScrolledConversationRef.current = selectedID
    if (!conversationChanged && !stickToBottomRef.current) return undefined
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: conversationChanged ? 'auto' : 'smooth' })
      stickToBottomRef.current = true
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages.length, selectedID])
  useEffect(() => { draftAttachmentRef.current = draftAttachment }, [draftAttachment])
  useEffect(() => () => { if (draftAttachmentRef.current?.url) URL.revokeObjectURL(draftAttachmentRef.current.url) }, [])
  useEffect(() => {
    setViewingImage(null)
    setDraftAttachment(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })
  }, [selectedID])
  useEffect(() => {
    if (!viewingImage) return undefined
    const close = event => { if (event.key === 'Escape') setViewingImage(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [viewingImage])

  const selected = sectionConversations.find(item => String(item.id) === String(selectedID))
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('ru-RU')
    if (!needle) return sectionConversations
    return sectionConversations.filter(item => `${item.subject || item.title} ${item.last_message} ${item.members.map(member => member.name).join(' ')}`.toLocaleLowerCase('ru-RU').includes(needle))
  }, [sectionConversations, search])
  const accountingUnread = useMemo(
    () => conversations.filter(item => item.category === ACCOUNTING_SECTION).reduce((total, item) => total + Number(item.unread || 0), 0),
    [conversations],
  )

  const send = async event => {
    event.preventDefault()
    const body = draft.trim()
    if ((!body && !draftAttachment) || !selectedID || sending) return
    setSending(true)
    try {
      let payload
      if (draftAttachment) {
        payload = new FormData()
        payload.append('body', body)
        payload.append('file', draftAttachment.file, draftAttachment.file.name || 'document')
      }
      const message = await request(`/api/chat/conversations/${selectedID}/messages`, { method: 'POST', body: payload || JSON.stringify({ body }) })
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message])
      setDraft('')
      setDraftAttachment(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })
      loadConversations()
    } catch (error) { notify(error.message, 'error') } finally { setSending(false) }
  }

  const selectAttachment = file => {
    if (!file) return
    if (file.size <= 0 || file.size > CHAT_FILE_LIMIT) { notify('Файл должен быть не больше 25 МБ', 'error'); return }
    const extension = `.${file.name.split('.').pop()?.toLowerCase()}`
    if (!CHAT_FILE_ACCEPT.split(',').includes(extension)) { notify('Поддерживаются PDF, изображения, DOCX, XLSX, CSV, TXT и ZIP', 'error'); return }
    setDraftAttachment(current => {
      if (current?.url) URL.revokeObjectURL(current.url)
      return { file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : '' }
    })
  }

  const pasteImage = event => {
    const item = [...(event.clipboardData?.items || [])].find(value => value.kind === 'file' && value.type.startsWith('image/'))
    if (!item) return
    const file = item.getAsFile()
    if (!file) return
    event.preventDefault()
    lastImagePasteRef.current = Date.now()
    selectAttachment(file)
  }

  const dropAttachment = event => {
    event.preventDefault(); setDragActive(false)
    selectAttachment(event.dataTransfer.files?.[0])
  }

  const analyzeChatAttachment = async message => {
    if (!message?.attachment_url || !message.ai_scannable || !canAIScan) return
    try {
      const blob = await requestBlob(message.attachment_url)
      const file = new File([blob], message.attachment_name || 'document.pdf', { type: message.attachment_type || blob.type })
      setAISource({ file, message })
      await runChatAIScan(file)
    } catch (error) { notify(error.message, 'error') }
  }

  const runChatAIScan = async file => {
    setAIScan({ loading: true, filename: file.name, error: '' })
    const body = new FormData(); body.append('scan', file)
    try {
      let result = await request('/api/obligations/ai-scan', { method: 'POST', body })
      setAIScan({ ...result, loading: true, filename: file.name, error: '' })
      for (let attempt = 0; result.status === 'processing' && attempt < 360; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 2000))
        result = await request(`/api/obligations/ai-scan/${result.batch}/status`)
      }
      if (result.status === 'processing') throw new Error('Распознавание не завершилось за 12 минут. Разделите PDF на части')
      if (result.status === 'error') throw new Error(result.error || 'Не удалось распознать документ')
      const items = result.items.map(item => ({ page: item.page, pages: normalizeAIScanDocumentPages(item), include: !item.duplicate, duplicate: item.duplicate, duplicate_matches: item.duplicate_matches || [], warnings: item.warnings || [], confidence: item.confidence || {}, values: buildAIScanObligationValues(blankObligation(), item) }))
      setAIScan({ ...result, filename: file.name, items, loading: false, error: '' })
    } catch (error) { setAIScan({ loading: false, filename: file.name, error: error.message }) }
  }

  const saveChatAIScan = async items => {
    setAIScan(current => ({ ...current, saving: true }))
    try {
      const result = await request(`/api/obligations/ai-scan/${aiScan.batch}/commit`, { method: 'POST', body: JSON.stringify({ items: items.map(item => ({ page: item.page, values: stripAIScanValues(item.values) })) }) })
      notify(`Из файла добавлено ${result.created} обязательств${result.created_references ? `; новых контрагентов: ${result.created_references}` : ''}`)
      setAIScan(null); setAISource(null)
      request('/api/references').then(setReferences).catch(error => notify(error.message, 'error'))
    } catch (error) { setAIScan(current => ({ ...current, saving: false })); notify(error.message, 'error') }
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
    setSection('chats')
    await loadConversations()
    selectConversation(id)
  }

  const accountingMailSent = async id => {
    setComposingAccountingMail(false)
    setSection(ACCOUNTING_SECTION)
    setAccountingFolder('sent')
    await loadConversations()
    selectConversation(id)
  }

  return <div className={`chat-page ${compact ? 'chat-page-compact' : ''} ${selected ? 'has-room' : ''}`}>
    <aside className="chat-list-panel">
      <header><div><p>{section === ACCOUNTING_SECTION ? 'Документы' : 'Команда'}</p><h1>Сообщения</h1></div><div className="chat-list-actions">{notificationPermission === 'default' && <button type="button" className="chat-enable-bell" onClick={onEnableNotifications} aria-label="Включить уведомления" title="Включить уведомления"><BellRing size={17}/></button>}{section === 'chats' && canCreate && <button type="button" onClick={() => setCreating(true)} aria-label="Начать новый чат" title="Начать новый чат"><Plus size={19}/></button>}</div></header>
      {(canMailInbox || canMailSend) && <div className="chat-section-tabs" role="tablist" aria-label="Раздел сообщений"><button type="button" role="tab" aria-selected={section === 'chats'} className={section === 'chats' ? 'active' : ''} onClick={() => switchSection('chats')}><MessageCircle size={15}/>Чаты</button><button type="button" role="tab" aria-selected={section === ACCOUNTING_SECTION} className={section === ACCOUNTING_SECTION ? 'active' : ''} onClick={() => switchSection(ACCOUNTING_SECTION)}><FileText size={15}/>Счета в бухгалтерию{accountingUnread > 0 && <b>{accountingUnread > 99 ? '99+' : accountingUnread}</b>}</button></div>}
      {section === ACCOUNTING_SECTION && <div className="accounting-mail-toolbar"><div className="accounting-mail-folders" role="tablist" aria-label="Папка счетов">{canMailInbox && <button type="button" role="tab" aria-selected={accountingFolder === 'inbox'} className={accountingFolder === 'inbox' ? 'active' : ''} onClick={() => switchAccountingFolder('inbox')}><Inbox size={14}/>Входящие</button>}<button type="button" role="tab" aria-selected={accountingFolder === 'sent'} className={accountingFolder === 'sent' ? 'active' : ''} onClick={() => switchAccountingFolder('sent')}><SendHorizontal size={14}/>Отправленные</button></div>{canMailSend && <button type="button" className="accounting-mail-create" onClick={() => setComposingAccountingMail(true)}><MailPlus size={15}/><span>Отправить счёт</span></button>}</div>}
      <label className="chat-search"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder={section === ACCOUNTING_SECTION ? 'Поиск по теме или отправителю' : 'Поиск диалогов'}/></label>
      <div className="chat-conversations">
        {filtered.map(item => <button type="button" key={item.id} className={item.id === selectedID ? 'active' : ''} onClick={() => selectConversation(item.id)}>
          <ConversationAvatar item={item} currentUser={user}/>
          <span className="chat-conversation-copy"><strong>{item.subject || item.title}</strong><small className={item.category === ACCOUNTING_SECTION ? 'accounting-route' : ''}>{item.category === ACCOUNTING_SECTION ? accountingConversationPreview(item, user) : item.last_message ? `${item.last_sender}: ${item.last_message}` : item.kind === 'group' ? `${item.members.length} участников` : 'Начните общение'}</small></span>
          <span className="chat-conversation-meta"><time>{chatListTime(item.last_at)}</time>{item.unread > 0 && <b>{item.unread > 99 ? '99+' : item.unread}</b>}</span>
        </button>)}
        {!filtered.length && (section === ACCOUNTING_SECTION ? <div className="chat-list-empty chat-accounting-empty"><FileText size={27}/><strong>{search ? 'Ничего не найдено' : accountingFolder === 'inbox' ? 'Новых счетов нет' : 'Счета ещё не отправлялись'}</strong><span>{search ? 'Попробуйте другой запрос' : accountingFolder === 'inbox' ? 'Счета сотрудников появятся здесь' : 'Отправленные документы сохраняются как письма'}</span>{!search && canMailSend && <button type="button" className="primary" onClick={() => setComposingAccountingMail(true)}><MailPlus size={15}/>Отправить счёт</button>}</div> : <div className="chat-list-empty"><MessageCircle size={25}/><strong>{search ? 'Ничего не найдено' : 'Диалогов пока нет'}</strong><span>{search ? 'Попробуйте другой запрос' : 'Напишите коллеге или создайте группу'}</span></div>)}
      </div>
    </aside>

    <main className="chat-room">
      {selected ? <>
        <header className="chat-room-head">{compact && <button type="button" className="chat-room-back" onClick={closeConversation} aria-label="Назад к диалогам"><ChevronLeft size={19}/></button>}<ConversationAvatar item={selected} currentUser={user}/><div><strong>{selected.subject || selected.title}</strong><span>{conversationSubtitle(selected, user)}</span>{selected.category === ACCOUNTING_SECTION && <em className="accounting-route-label">Получатель: Бухгалтерия</em>}</div></header>
        <div className="chat-messages" ref={messagesViewportRef} onScroll={event => {
          const viewport = event.currentTarget
          stickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80
        }}>
          {!messages.length && <div className="chat-welcome"><div><MessageCircle size={30}/></div><strong>Начните разговор</strong><span>Сообщения доступны только участникам этого диалога.</span></div>}
          {messages.map((message, index) => {
            const mine = message.sender_id === user.id
            const newGroup = index === 0 || messages[index - 1].sender_id !== message.sender_id || messages[index - 1].created_at.slice(0, 10) !== message.created_at.slice(0, 10)
            const newDay = index === 0 || messages[index - 1].created_at.slice(0, 10) !== message.created_at.slice(0, 10)
            return <div key={message.id}>{newDay && <div className="chat-day"><span>{chatDay(message.created_at)}</span></div>}<div className={`chat-message ${mine ? 'mine' : ''} ${newGroup ? 'new-group' : ''}`}>
              {!mine && newGroup && <span className="chat-message-avatar">{initials(message.sender_name)}</span>}
              <div className={`chat-bubble ${message.attachment_url ? 'has-attachment' : ''} ${message.image_url ? 'has-image' : ''}`}>{!mine && newGroup && <strong>{message.sender_name}</strong>}{message.image_url ? <ChatImage path={message.image_url} alt={`Изображение от ${message.sender_name}`} onOpen={() => setViewingImage({ path: message.image_url, alt: `Изображение от ${message.sender_name}` })}/> : message.attachment_url && <ChatFile message={message} notify={notify}/>} {message.body && <p>{message.body}</p>}{message.ai_scannable && canAIScan && <button type="button" className="chat-file-ai" onClick={() => analyzeChatAttachment(message)}><ScanLine size={15}/>AI сканирование</button>}<time>{chatClock(message.created_at)}</time></div>
            </div></div>
          })}
        </div>
        {canSend ? <form className={`chat-composer ${draftAttachment ? 'has-attachment' : ''} ${dragActive ? 'is-dragging' : ''}`} onSubmit={send} onDragEnter={event => { event.preventDefault(); setDragActive(true) }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false) }} onDrop={dropAttachment}>
          {dragActive && <div className="chat-drop-zone"><Paperclip size={22}/><strong>Перетащите файл сюда</strong><span>До 25 МБ</span></div>}
          {draftAttachment && <div className="chat-composer-preview">{draftAttachment.url ? <img src={draftAttachment.url} alt="Файл перед отправкой"/> : <span className="chat-file-icon"><FileText size={27}/></span>}<span><strong>{draftAttachment.file.name}</strong><small>{formatFileSize(draftAttachment.file.size)}</small></span><button type="button" onClick={() => setDraftAttachment(current => { if (current?.url) URL.revokeObjectURL(current.url); return null })} aria-label="Удалить файл" title="Удалить файл"><X size={16}/></button></div>}
          <div className="chat-composer-main"><input ref={fileInputRef} type="file" accept={CHAT_FILE_ACCEPT} hidden onChange={event => { selectAttachment(event.target.files?.[0]); event.target.value = '' }}/><button type="button" className="chat-attach-button" onClick={() => fileInputRef.current?.click()} aria-label="Прикрепить файл" title="Прикрепить файл"><Paperclip size={19}/></button><textarea value={draft} onChange={event => setDraft(event.target.value)} onPaste={pasteImage} onKeyDown={composerKeyDown} maxLength={3900} rows={1} placeholder="Сообщение или перетащите файл…"/><button type="submit" disabled={(!draft.trim() && !draftAttachment) || sending} aria-label="Отправить сообщение"><Send size={19}/></button></div>
        </form> : <div className="chat-readonly-note">Доступен только просмотр сообщений</div>}
      </> : section === ACCOUNTING_SECTION ? <div className="chat-no-room"><div><FileText size={34}/></div><h2>Счета в бухгалтерию</h2><p>Отправляйте счета как письма: укажите тему, добавьте описание и приложите документ.</p>{canMailSend && <button type="button" className="primary" onClick={() => setComposingAccountingMail(true)}><MailPlus size={17}/>Отправить счёт</button>}</div> : <div className="chat-no-room"><div><MessageCircle size={34}/></div><h2>Корпоративный чат</h2><p>Общайтесь с коллегами лично или создавайте группы для совместной работы.</p>{canCreate && <button type="button" className="primary" onClick={() => setCreating(true)}><UserPlus size={17}/>Начать общение</button>}</div>}
    </main>
    {creating && canCreate && <NewChatModal currentUser={user} contacts={contacts} onClose={() => setCreating(false)} onCreated={conversationCreated} notify={notify}/>}
    {composingAccountingMail && canMailSend && <AccountingMailModal onClose={() => setComposingAccountingMail(false)} onSent={accountingMailSent} notify={notify}/>}
    {viewingImage && <div className="chat-image-viewer" role="dialog" aria-modal="true" aria-label="Просмотр изображения" onClick={() => setViewingImage(null)}><button type="button" onClick={() => setViewingImage(null)} aria-label="Закрыть изображение" title="Закрыть"><X size={25}/></button><ChatImage path={viewingImage.path} alt={viewingImage.alt} fullscreen onClick={event => event.stopPropagation()}/></div>}
    {aiScan && <AIScanModal state={aiScan} references={references} onChange={setAIScan} onRetry={() => aiSource?.file && runChatAIScan(aiSource.file)} onClose={() => !aiScan.loading && !aiScan.saving && setAIScan(null)} onSave={saveChatAIScan}/>}
  </div>
}

function ChatFile({ message, notify }) {
  const downloadFile = async () => {
    try {
      const blob = await requestBlob(message.attachment_url)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = message.attachment_name || 'document'; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { notify(error.message, 'error') }
  }
  return <div className="chat-file-card"><span><FileText size={24}/></span><div><strong>{message.attachment_name}</strong><small>{formatFileSize(message.attachment_size || 0)}</small></div><button type="button" onClick={downloadFile} aria-label={`Скачать ${message.attachment_name}`} title="Скачать файл"><Download size={17}/></button></div>
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

function AccountingMailModal({ onClose, onSent, notify }) {
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape' && !sending) onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [sending, onClose])

  const selectFile = nextFile => {
    if (!nextFile) return
    const error = validateAccountingMailDraft({ subject: 'Счёт', description: '', file: nextFile })
    if (error) { notify(error, 'error'); return }
    setFile(nextFile)
  }

  const submit = async event => {
    event.preventDefault()
    if (sending) return
    const error = validateAccountingMailDraft({ subject, description, file })
    if (error) { notify(error, 'error'); return }
    setSending(true)
    const payload = new FormData()
    payload.append('body', description.trim())
    payload.append('file', file, file.name || 'invoice')
    try {
      const result = await request(`/api/chat/accounting?subject=${encodeURIComponent(subject.trim())}`, { method: 'POST', body: payload })
      notify('Счёт отправлен в бухгалтерию')
      await onSent(result.id)
    } catch (requestError) {
      notify(requestError.message, 'error')
      setSending(false)
    }
  }

  return <div className="modal-backdrop accounting-mail-backdrop"><form className="modal accounting-mail-compose" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="accounting-mail-title">
    <div className="modal-head"><div><p className="eyebrow">Новое письмо</p><h2 id="accounting-mail-title">Отправить счёт</h2><span>Документ получат все активные сотрудники бухгалтерии.</span></div><button type="button" onClick={onClose} disabled={sending} aria-label="Закрыть"><X/></button></div>
    <div className="accounting-mail-body">
      <div className="accounting-mail-recipient"><span>Кому</span><div><strong>Бухгалтерия</strong><small>Получатели определяются автоматически по роли и правам</small></div><i><Building2 size={19}/></i></div>
      <label className="field"><span>Тема письма *</span><input autoFocus required value={subject} maxLength={ACCOUNTING_SUBJECT_LIMIT} onChange={event => setSubject(event.target.value)} placeholder="Например, счёт за медицинское оборудование"/></label>
      <span className="accounting-mail-counter">{[...subject].length} / {ACCOUNTING_SUBJECT_LIMIT}</span>
      <label className="field"><span>Описание</span><textarea value={description} maxLength={ACCOUNTING_DESCRIPTION_LIMIT} onChange={event => setDescription(event.target.value)} placeholder="Комментарий для бухгалтерии, срок или назначение платежа"/></label>
      <span className="accounting-mail-counter">{[...description].length} / {ACCOUNTING_DESCRIPTION_LIMIT}</span>
      <div className={`accounting-mail-drop ${dragging ? 'is-dragging' : ''}`} onDragEnter={event => { event.preventDefault(); setDragging(true) }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0]) }}>
        <input ref={inputRef} type="file" accept={ACCOUNTING_FILE_ACCEPT} onChange={event => { selectFile(event.target.files?.[0]); event.target.value = '' }}/>
        {file ? <div className="accounting-mail-file"><i><FileText size={25}/></i><span><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span><button type="button" onClick={() => setFile(null)} aria-label="Удалить приложенный счёт" title="Удалить файл"><X size={16}/></button></div> : <><UploadCloud size={29}/><strong>Перетащите файл счёта сюда</strong><span>Обязательное вложение до 25 МБ</span><button type="button" className="secondary" onClick={() => inputRef.current?.click()}><Paperclip size={15}/>Выбрать файл</button></>}
      </div>
    </div>
    <div className="modal-footer accounting-mail-actions"><span>Получатель: Бухгалтерия</span><button type="button" className="secondary" onClick={onClose} disabled={sending}>Отмена</button><button type="submit" className="primary" disabled={sending || !subject.trim() || !file}><SendHorizontal size={16}/>{sending ? 'Отправляем…' : 'Отправить счёт'}</button></div>
  </form></div>
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
  if (item.category === ACCOUNTING_SECTION) return <span className="conversation-avatar accounting"><FileText size={18}/></span>
  if (item.kind === 'group') return <span className="conversation-avatar group"><Users size={18}/></span>
  const other = item.members.find(member => member.id !== currentUser.id)
  return <span className="conversation-avatar">{initials(other?.name || item.title)}</span>
}
function accountingSender(item) { return item.members.find(member => String(member.id) === String(item.created_by)) }
function accountingConversationPreview(item, user) { const route = String(item.created_by) === String(user.id) ? 'Вы → Бухгалтерия' : `${accountingSender(item)?.name || item.last_sender || 'Сотрудник'} → Бухгалтерия`; return `${route}${item.last_message ? ` · ${item.last_message}` : ''}` }
function conversationSubtitle(item, user) { if (item.category === ACCOUNTING_SECTION) return String(item.created_by) === String(user.id) ? 'Отправлено вами' : `Отправитель: ${accountingSender(item)?.name || item.last_sender || 'Сотрудник'}`; if (item.kind === 'group') return `${item.members.length} участников · ${item.members.map(member => member.id === user.id ? 'Вы' : member.name).join(', ')}`; const other = item.members.find(member => member.id !== user.id); return other ? `${other.email} · ${roleLabel(other.role)}` : 'Личный диалог' }
function initials(value = '') { return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '•' }
function parseChatDate(value) { return value ? new Date(value.replace(' ', 'T')) : null }
function chatClock(value) { const date = parseChatDate(value); return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '' }
function chatDay(value) { const date = parseChatDate(value); if (!date || Number.isNaN(date.getTime())) return ''; const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const key = date.toDateString(); if (key === today.toDateString()) return 'Сегодня'; if (key === yesterday.toDateString()) return 'Вчера'; return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) }
function chatListTime(value) { const date = parseChatDate(value); if (!date || Number.isNaN(date.getTime())) return ''; const today = new Date(); return date.toDateString() === today.toDateString() ? chatClock(value) : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) }
function formatFileSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function blankObligation() { return { account_type:'',entry_date:todayISO(),counterparty:'',legal_entity:'',cost_category:'',priority:'',responsible:'',document_number:'',deferment_days:null,document_date:'',amount:null,planned_payment_date:'',approval_date:'',actual_payment_date:'',status:'Зарегистрирован',urgency:'',comment:'',source_note:'' } }
function stripAIScanValues(values) { const result = { ...values }; for (const field of ['id','created_at','updated_at','overdue','due_soon','split_group_id','split_parent_id','installment_number','installment_count']) delete result[field]; return result }
