import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, BookOpen, ChevronLeft, ChevronRight, CircleDollarSign, FileClock, LogOut, Menu, ReceiptText, Settings, Users } from 'lucide-react'
import { request } from './api'
import Dashboard from './Dashboard'
import Registry from './Registry'
import Payments from './Payments'
import References from './References'
import UsersPage from './UsersPage'
import Audit from './Audit'

const nav = [
  { id: 'dashboard', label: 'Сводка', icon: BarChart3 },
  { id: 'registry', label: 'Реестр', icon: BookOpen },
  { id: 'payments', label: 'К оплате', icon: CircleDollarSign },
  { id: 'references', label: 'Справочники', icon: Settings, admin: true },
  { id: 'users', label: 'Пользователи', icon: Users, admin: true },
  { id: 'audit', label: 'Журнал действий', icon: FileClock, admin: true },
]

export default function App() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(Boolean(localStorage.getItem('registry_token')))
  const [page, setPage] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [toast, setToast] = useState(null)

  useEffect(() => {
    if (!checking) return
    request('/api/auth/me').then(setUser).catch(() => setUser(null)).finally(() => setChecking(false))
  }, [])
  useEffect(() => {
    const logout = () => { setUser(null); setChecking(false) }
    window.addEventListener('registry:logout', logout)
    return () => window.removeEventListener('registry:logout', logout)
  }, [])

  const notify = (message, type = 'success') => {
    setToast({ message, type }); window.setTimeout(() => setToast(null), 3500)
  }
  const logout = () => { localStorage.removeItem('registry_token'); setUser(null) }
  if (checking) return <div className="splash"><ReceiptText size={42}/><span>Загружаем реестр…</span></div>
  if (!user) return <Login onLogin={setUser} />

  const pages = {
    dashboard: <Dashboard notify={notify} />,
    registry: <Registry user={user} notify={notify} />,
    payments: <Payments user={user} notify={notify} />,
    references: <References notify={notify} />,
    users: <UsersPage notify={notify} />,
    audit: <Audit notify={notify} />,
  }

  return <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ReceiptText size={23}/></div><div><strong>ФинРеестр</strong><span>обязательства</span></div></div>
      <nav>{nav.filter(item => !item.admin || user.role === 'admin').map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)} title={item.label}><item.icon size={19}/><span>{item.label}</span>{item.id === 'payments' && <i/>}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className="collapse" onClick={() => setCollapsed(v => !v)}>{collapsed ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}<span>Свернуть</span></button>
        <div className="profile"><div className="avatar">{user.name.slice(0, 1)}</div><div><strong>{user.name}</strong><span>{roleLabel(user.role)}</span></div><button onClick={logout} title="Выйти"><LogOut size={17}/></button></div>
      </div>
    </aside>
    <main className="main"><button className="mobile-menu" onClick={() => setCollapsed(v => !v)}><Menu/></button>{pages[page]}</main>
    {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
  </div>
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('admin@registry.local')
  const [password, setPassword] = useState('Admin123!')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async event => {
    event.preventDefault(); setError(''); setLoading(true)
    try { const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); localStorage.setItem('registry_token', result.token); onLogin(result.user) }
    catch (err) { setError(err.message) } finally { setLoading(false) }
  }
  return <div className="login-page">
    <div className="login-visual"><div className="login-badge"><ReceiptText size={25}/><span>ФинРеестр</span></div><div className="login-copy"><p>ЕДИНЫЙ РЕЕСТР</p><h1>Обязательства<br/>под контролем.</h1><span>Фильтры не сбрасываются. Справочники работают. Каждое изменение сохраняется в журнале.</span></div><div className="visual-card"><span>Всегда актуально</span><strong>Одна версия данных для всей команды</strong><div><i/><i/><i/><i/><i/></div></div></div>
    <div className="login-form-wrap"><form onSubmit={submit}><div className="form-logo"><div className="brand-mark"><ReceiptText size={22}/></div></div><p className="eyebrow">Добро пожаловать</p><h2>Войдите в реестр</h2><span className="muted">Используйте рабочую учётную запись</span><label>Электронная почта<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus/></label><label>Пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)}/></label>{error && <div className="form-error">{error}</div>}<button className="primary wide" disabled={loading}>{loading ? 'Входим…' : 'Войти'}</button><div className="demo-hint"><strong>Демо-доступ</strong><span>admin@registry.local · Admin123!</span></div></form></div>
  </div>
}

export function PageHeader({ eyebrow, title, subtitle, actions }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{subtitle && <span>{subtitle}</span>}</div>{actions && <div className="header-actions">{actions}</div>}</header> }
export const roleLabel = role => ({ admin: 'Администратор', editor: 'Редактор', viewer: 'Зритель' }[role] || role)
export const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value || 0)
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
export function DateInput({ value, onChange, onClose, onFocus, autoFocus, closeOnScroll = true, className = '', ...props }) {
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
    const rect = inputRef.current?.getBoundingClientRect()
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
    const frame = requestAnimationFrame(() => { inputRef.current?.focus(); show() })
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
  return <><div ref={rootRef} className={`date-input-wrap ${open ? 'is-open' : ''}`}><input ref={inputRef} {...props} className={className} type="text" inputMode="numeric" placeholder="дд/мм/гггг" value={draft} onChange={event => setDraft(event.target.value)} onFocus={show} onClick={show} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } if (event.key === 'Escape') { event.preventDefault(); setDraft(value ? shortDate(value) : ''); hide() } }}/></div>{open && createPortal(<div ref={calendarRef} className="custom-calendar" style={position} role="dialog" aria-label="Выбор даты">
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
