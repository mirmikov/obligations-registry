import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, BellRing, BookOpen, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, FileClock, Landmark, LogOut, Maximize2, Menu, MessageCircle, Minus, ReceiptText, Settings, Undo2, Users, X } from 'lucide-react'
import { request } from './api'
import Dashboard from './Dashboard'
import Registry from './Registry'
import Payments from './Payments'
import References from './References'
import UsersPage from './UsersPage'
import Audit from './Audit'
import CreditsLeasing from './CreditsLeasing'
import Chat from './Chat'
import useChatNotifications from './useChatNotifications'

const nav = [
  { id: 'dashboard', label: 'Сводка', icon: BarChart3 },
  { id: 'registry', label: 'Реестр', icon: BookOpen, children: [{ id: 'credits-leasing', label: 'Кредиты и лизинги', icon: Landmark }] },
  { id: 'payments', label: 'К оплате', icon: CircleDollarSign },
  { id: 'chat', label: 'Чаты', icon: MessageCircle },
  { id: 'references', label: 'Справочники', icon: Settings, editor: true },
  { id: 'users', label: 'Пользователи', icon: Users, admin: true },
  { id: 'audit', label: 'Журнал действий', icon: FileClock, admin: true },
]

export default function App() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(Boolean(localStorage.getItem('registry_token')))
  const [page, setPage] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [toast, setToast] = useState(null)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [chatTarget, setChatTarget] = useState(null)
  const [undoState, setUndoState] = useState({ available: false, remaining: 0, loading: true })
  const [undoing, setUndoing] = useState(false)
  const [dataRevision, setDataRevision] = useState(0)

  const enterWorkspace = (nextUser, state = {}) => {
    setUser(nextUser)
    setPage(isAllowedPage(state.page, nextUser) ? state.page : 'dashboard')
    setRegistryOpen(state.page === 'credits-leasing')
    setCollapsed(Boolean(state.sidebar_collapsed))
    setWorkspaceReady(true)
  }

  useEffect(() => {
    if (!checking) return
    Promise.all([request('/api/auth/me'), request('/api/workspace-state').catch(() => ({}))])
      .then(([nextUser, state]) => enterWorkspace(nextUser, state))
      .catch(() => { setUser(null); setWorkspaceReady(false) })
      .finally(() => setChecking(false))
  }, [])
  useEffect(() => {
    const logout = () => { setUser(null); setChecking(false); setWorkspaceReady(false) }
    window.addEventListener('registry:logout', logout)
    return () => window.removeEventListener('registry:logout', logout)
  }, [])
  useEffect(() => {
    if (!user || !workspaceReady) return
    request('/api/workspace-state', { method: 'PUT', body: JSON.stringify({ page, sidebar_collapsed: collapsed }), keepalive: true }).catch(() => {})
  }, [page, collapsed, user?.id, workspaceReady])
  useEffect(() => {
    if (!user) return undefined
    let active = true
    const load = () => request('/api/undo').then(value => { if (active) setUndoState({ ...value, loading: false }) }).catch(() => { if (active) setUndoState(current => ({ ...current, loading: false })) })
    load()
    const timer = window.setInterval(load, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [user?.id])

  const notify = (message, type = 'success') => {
    setToast({ message, type }); window.setTimeout(() => setToast(null), 3500)
  }
  const openChat = conversationID => { setChatTarget(conversationID || null); setPage('chat') }
  const chatNotifications = useChatNotifications({ user, page, onOpenChat: openChat, notify })
  const logout = () => { localStorage.removeItem('registry_token'); setUser(null); setWorkspaceReady(false) }
  const undoLast = async () => {
    if (!undoState.available || undoing) return
    if (!window.confirm(`Отменить последнее действие?\n\n${undoState.description}`)) return
    setUndoing(true)
    try {
      const result = await request('/api/undo', { method: 'POST', body: '{}' })
      notify(`Отменено: ${result.description}`)
      setDataRevision(value => value + 1)
      const next = await request('/api/undo')
      setUndoState({ ...next, loading: false })
    } catch (error) { notify(error.message, 'error') } finally { setUndoing(false) }
  }
  if (checking) return <div className="splash"><ReceiptText size={42}/><span>Загружаем реестр…</span></div>
  if (!user) return <Login onLogin={enterWorkspace} />

  const pages = {
    dashboard: <Dashboard key={`dashboard-${dataRevision}`} notify={notify} />,
    registry: <Registry key={`registry-${dataRevision}`} user={user} notify={notify} />,
    'credits-leasing': <CreditsLeasing key={`credits-${dataRevision}`} notify={notify} />,
    payments: <Payments key={`payments-${dataRevision}`} user={user} notify={notify} />,
    chat: <Chat user={user} notify={notify} initialConversationID={chatTarget} notificationPermission={chatNotifications.permission} onEnableNotifications={chatNotifications.requestPermission} />,
    references: <References key={`references-${dataRevision}`} notify={notify} />,
    users: <UsersPage key={`users-${dataRevision}`} notify={notify} />,
    audit: <Audit key={`audit-${dataRevision}`} notify={notify} />,
  }

  return <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ReceiptText size={23}/></div><div><strong>ФинРеестр</strong><span>обязательства</span></div></div>
      <nav>{nav.filter(item => isAllowedNavItem(item, user)).map(item => item.children ? <div className={`nav-group ${registryOpen ? 'is-open' : ''}`} key={item.id}><div className="nav-parent"><button className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)} title={item.label}><item.icon size={19}/><span>{item.label}</span></button><button type="button" className="nav-expand" onClick={() => setRegistryOpen(value => !value)} title={registryOpen ? 'Свернуть раздел' : 'Развернуть раздел'} aria-label={registryOpen ? 'Свернуть раздел Реестр' : 'Развернуть раздел Реестр'} aria-expanded={registryOpen}><ChevronDown size={16}/></button></div>{registryOpen && <div className="nav-children">{item.children.map(child => <button key={child.id} className={page === child.id ? 'active' : ''} onClick={() => setPage(child.id)} title={child.label}><child.icon size={17}/><span>{child.label}</span></button>)}</div>}</div> : <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => item.id === 'chat' ? openChat() : setPage(item.id)} title={item.label}><item.icon size={19}/><span>{item.label}</span>{item.id === 'chat' && chatNotifications.unread > 0 && <b className="nav-unread">{unreadLabel(chatNotifications.unread)}</b>}{item.id === 'payments' && <i/>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button type="button" className={`undo-action ${undoing ? 'is-loading' : ''}`} onClick={undoLast} disabled={!undoState.available || undoState.loading || undoing || user.role === 'viewer'} title={undoState.available ? `Отменить: ${undoState.description}` : 'Нет действий для отмены'} aria-label={undoState.available ? `Отменить последнее действие: ${undoState.description}` : 'Нет действий для отмены'}><Undo2 size={18}/><span>{undoing ? 'Отменяем…' : 'Отменить действие'}</span>{undoState.remaining > 0 && <b>{Math.min(undoState.remaining, 500)}</b>}</button>
        <button className="collapse" onClick={() => setCollapsed(v => !v)}>{collapsed ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}<span>Свернуть</span></button>
        <div className="profile"><div className="avatar">{user.name.slice(0, 1)}</div><div><strong>{user.name}</strong><span>{roleLabel(user.role)}</span></div><button onClick={logout} title="Выйти"><LogOut size={17}/></button></div>
      </div>
    </aside>
    <main className="main"><button className="mobile-menu" onClick={() => setCollapsed(v => !v)}><Menu/></button>{pages[page]}</main>
    <ChatNotificationStack notices={chatNotifications.notices} onDismiss={chatNotifications.dismissNotice} onOpen={openChat}/>
    {page !== 'chat' && <ChatWidget user={user} notify={notify} unread={chatNotifications.unread} notificationPermission={chatNotifications.permission} onEnableNotifications={chatNotifications.requestPermission} onOpenFull={() => openChat()}/>}
    {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
  </div>
}

function ChatWidget({ user, notify, unread, notificationPermission, onEnableNotifications, onOpenFull }) {
  const [open, setOpen] = useState(false)
  return <div className={`chat-widget ${open ? 'is-open' : ''}`}>
    {open ? <section className="chat-widget-panel">
      <header className="chat-widget-bar"><div><MessageCircle size={16}/><strong>Чат команды</strong>{unread > 0 && <b className="chat-widget-unread">{unreadLabel(unread)}</b>}</div><div><button type="button" onClick={onOpenFull} title="Открыть чат на всю страницу" aria-label="Открыть чат на всю страницу"><Maximize2 size={16}/></button><button type="button" onClick={() => setOpen(false)} title="Свернуть чат" aria-label="Свернуть чат"><Minus size={18}/></button></div></header>
      <Chat user={user} notify={notify} compact notificationPermission={notificationPermission} onEnableNotifications={onEnableNotifications}/>
    </section> : <div className="chat-widget-closed">{notificationPermission === 'default' && <button type="button" className="chat-notification-enable" onClick={onEnableNotifications} title="Включить уведомления о сообщениях"><BellRing size={16}/><span>Включить уведомления</span></button>}<button type="button" className="chat-widget-launcher" onClick={() => setOpen(true)} title="Открыть чат" aria-label={`Открыть чат${unread ? `, непрочитанных сообщений: ${unread}` : ''}`}><MessageCircle size={24}/><span>Чат</span>{unread > 0 && <b>{unreadLabel(unread)}</b>}</button></div>}
  </div>
}

function ChatNotificationStack({ notices, onDismiss, onOpen }) {
  if (!notices.length) return null
  return <section className="chat-notification-stack" aria-label="Новые сообщения" aria-live="polite">
    {notices.map(notice => <article className="chat-site-notification" key={notice.conversationID}>
      <button type="button" className={`chat-site-avatar ${notice.group ? 'group' : ''}`} onClick={() => { onDismiss(notice.conversationID); onOpen(notice.conversationID) }} aria-label={`Открыть чат ${notice.title}`}>{initials(notice.title)}</button>
      <button type="button" className="chat-site-content" onClick={() => { onDismiss(notice.conversationID); onOpen(notice.conversationID) }}><span>{notice.group ? notice.title : 'Новое сообщение'}</span><strong>{notice.group && notice.sender ? notice.sender : notice.title}</strong><p>{notice.body}</p></button>
      {notice.added > 1 && <b className="chat-site-count">+{notice.added}</b>}
      <button type="button" className="chat-site-close" onClick={() => onDismiss(notice.conversationID)} title="Закрыть уведомление" aria-label="Закрыть уведомление"><X size={15}/></button>
    </article>)}
  </section>
}

function unreadLabel(value) { return value > 99 ? '99+' : value }
function initials(value = '') { return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'Ч' }

function Login({ onLogin }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async event => {
    event.preventDefault(); setError(''); setLoading(true)
    try {
      const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: login, password }) })
      localStorage.setItem('registry_token', result.token)
      const workspace = await request('/api/workspace-state').catch(() => ({}))
      onLogin(result.user, workspace)
    }
    catch (err) { setError(err.message) } finally { setLoading(false) }
  }
  return <div className="login-page">
    <div className="login-visual"><div className="login-badge"><ReceiptText size={25}/><span>ФинРеестр</span></div><div className="login-copy"><p>ЕДИНЫЙ РЕЕСТР</p><h1>Обязательства<br/>под контролем.</h1><span>Фильтры не сбрасываются. Справочники работают. Каждое изменение сохраняется в журнале.</span></div><div className="visual-card"><span>Всегда актуально</span><strong>Одна версия данных для всей команды</strong><div><i/><i/><i/><i/><i/></div></div></div>
    <div className="login-form-wrap"><form onSubmit={submit}><div className="form-logo"><div className="brand-mark"><ReceiptText size={22}/></div></div><p className="eyebrow">Добро пожаловать</p><h2>Войдите в реестр</h2><span className="muted">Используйте рабочую учётную запись</span><label>Логин<input type="text" value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" autoFocus required/></label><label>Пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required/></label>{error && <div className="form-error">{error}</div>}<button className="primary wide" disabled={loading}>{loading ? 'Входим…' : 'Войти'}</button></form></div>
  </div>
}

export function PageHeader({ eyebrow, title, subtitle, actions }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{subtitle && <span>{subtitle}</span>}</div>{actions && <div className="header-actions">{actions}</div>}</header> }
function isAllowedNavItem(item, user) { return (!item.admin || user?.role === 'admin') && (!item.editor || user?.role === 'admin' || user?.role === 'editor') }
function isAllowedPage(page, user) { return nav.some(item => (item.id === page || item.children?.some(child => child.id === page)) && isAllowedNavItem(item, user)) }
export const roleLabel = role => ({ admin: 'Администратор', editor: 'Редактор', viewer: 'Зритель' }[role] || role)
export const money = value => new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value || 0)
export const shortDate = value => {
  if (!value) return '—'
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}
export const dateTime = value => {
  if (!value) return '—'
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](.*))?$/)
  return match ? `${match[3]}/${match[2]}/${match[1]}${match[4] ? ` ${match[4]}` : ''}` : value
}
export function DateInput({ value, onChange, onClose, onFocus, autoFocus, closeOnScroll = true, anchorRef, triggerOnly = false, className = '', ...props }) {
  const [draft, setDraft] = useState(value ? shortDate(value) : '')
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => monthFromValue(value))
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const calendarRef = useRef(null)
  useEffect(() => setDraft(value ? shortDate(value) : ''), [value])
  const hide = () => { setOpen(false); onClose?.() }
  const commit = () => {
    const parsed = parseDateDraft(draft)
    if (parsed == null) setDraft(value ? shortDate(value) : '')
    else { onChange(parsed); setDraft(parsed ? shortDate(parsed) : '') }
    hide()
  }
  const show = () => {
    const rect = anchorRef?.current?.getBoundingClientRect() || inputRef.current?.getBoundingClientRect()
    if (rect) {
      const width = 304; const height = 350
      const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10))
      const top = window.innerHeight - rect.bottom >= height ? rect.bottom + 6 : Math.max(10, rect.top - height - 6)
      setPosition({ left, top })
    }
    setViewMonth(monthFromValue(value)); setOpen(true); onFocus?.()
  }
  useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => { inputRef.current?.focus({ preventScroll: true }); show() })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    if (!open) return
    const outside = event => { if (!rootRef.current?.contains(event.target) && !calendarRef.current?.contains(event.target)) commit() }
    const closeOnScrollHandler = () => commit()
    document.addEventListener('mousedown', outside)
    if (closeOnScroll) window.addEventListener('scroll', closeOnScrollHandler, true)
    return () => { document.removeEventListener('mousedown', outside); if (closeOnScroll) window.removeEventListener('scroll', closeOnScrollHandler, true) }
  }, [open, draft, value, closeOnScroll])
  const choose = next => { onChange(next); setDraft(next ? shortDate(next) : ''); hide() }
  const selected = value || parseDateDraft(draft) || ''
  const year = viewMonth.getFullYear(); const month = viewMonth.getMonth(); const offset = (new Date(year, month, 1).getDay() + 6) % 7
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(year, month, index - offset + 1); return { date, iso: localISO(date), outside: date.getMonth() !== month } })
  const today = localISO(new Date())
  return <><div ref={rootRef} className={`date-input-wrap ${triggerOnly ? 'is-trigger-only' : ''} ${open ? 'is-open' : ''}`}><input ref={inputRef} {...props} className={className} type="text" inputMode="numeric" placeholder="дд/мм/гггг" value={draft} onChange={event => setDraft(event.target.value)} onFocus={show} onClick={show} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } if (event.key === 'Escape') { event.preventDefault(); setDraft(value ? shortDate(value) : ''); hide() } }}/></div>{open && createPortal(<div ref={calendarRef} className="custom-calendar" style={position} role="dialog" aria-label="Выбор даты">
    <div className="calendar-head"><button type="button" onClick={() => setViewMonth(new Date(year, month - 1, 1))} aria-label="Предыдущий месяц"><ChevronLeft size={17}/></button><strong>{capitalizeMonth(viewMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))}</strong><button type="button" onClick={() => setViewMonth(new Date(year, month + 1, 1))} aria-label="Следующий месяц"><ChevronRight size={17}/></button></div>
    <div className="calendar-weekdays">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="calendar-days">{days.map(day => <button type="button" key={day.iso} className={`${day.outside ? 'outside' : ''} ${day.iso === selected ? 'selected' : ''} ${day.iso === today ? 'today' : ''}`} onClick={() => choose(day.iso)} aria-label={shortDate(day.iso)}>{day.date.getDate()}</button>)}</div>
    <div className="calendar-footer"><button type="button" onClick={() => choose(today)}>Сегодня</button><button type="button" onClick={() => choose('')}>Очистить</button></div>
  </div>, document.body)}</>
}
function monthFromValue(value) { const match = String(value || '').match(/^(\d{4})-(\d{2})/); return match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
function localISO(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function parseDateDraft(draft) { if (!String(draft).trim()) return ''; const match = String(draft).trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/); if (!match) return null; const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3]); const date = new Date(year, month - 1, day); return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? localISO(date) : null }
function capitalizeMonth(value) { return value ? value[0].toUpperCase() + value.slice(1) : value }

