import { useEffect, useState } from 'react'
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
export const shortDate = value => value ? new Intl.DateTimeFormat('ru-RU').format(new Date(`${value}T00:00:00`)) : '—'
