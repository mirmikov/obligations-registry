import { useEffect, useState } from 'react'
import { Check, Code2, Plus, ShieldCheck, UserPen, X } from 'lucide-react'
import { request } from './api'
import { dateTime, PageHeader, roleLabel } from './App'
import { can } from './permissions'

export default function UsersPage({ user: currentUser, notify }) {
  const [users, setUsers] = useState([])
  const [catalog, setCatalog] = useState({ groups: [], presets: {} })
  const [editing, setEditing] = useState(null)
  const manageable = can(currentUser, 'users.manage')
  const granular = Boolean(currentUser?.is_developer)
  const load = () => Promise.all([request('/api/users'), request('/api/permissions/catalog')])
    .then(([items, permissions]) => { setUsers(items); setCatalog(permissions) })
    .catch(error => notify(error.message, 'error'))

  useEffect(() => { load() }, [])

  const save = async form => {
    try {
      const payload = { name: form.name, role: form.role === 'developer' ? 'admin' : form.role, active: form.active, password: form.password || '' }
      if (!form.id) payload.email = form.email
      if (granular && !form.is_developer) payload.permissions = form.permissions
      if (form.id) await request(`/api/users/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await request('/api/users', { method: 'POST', body: JSON.stringify(payload) })
      notify(form.id ? 'Пользователь и права обновлены' : 'Пользователь добавлен')
      setEditing(null)
      load()
    } catch (error) { notify(error.message, 'error') }
  }

  return <div className="page users-access-page">
    <PageHeader
      eyebrow="Доступ и роли"
      title="Пользователи"
      subtitle={granular ? 'Программист настраивает доступ к каждому разделу и действию' : 'Просмотр пользователей и назначенных прав'}
      actions={manageable && <button className="primary" onClick={() => setEditing({ permissions: catalog.presets.viewer || {} })}><Plus size={17}/>Добавить</button>}
    />
    <div className="role-cards">
      <RoleCard role="developer" icon={<Code2/>} title="Программист" text="Все права и управление индивидуальными доступами"/>
      <RoleCard role="admin" title="Администратор" text="Полный рабочий доступ без управления ролью программиста"/>
      <RoleCard role="editor" title="Редактор" text="Работа с реестром, оплатами и справочниками"/>
      <RoleCard role="viewer" title="Зритель" text="Просмотр основных разделов без изменения данных"/>
    </div>
    <section className="panel users-panel">
      <div className="simple-table-head"><span>Пользователь</span><span>Роль</span><span>Статус</span><span>Создан</span><span/></div>
      {users.map(item => <div className="simple-table-row" key={item.id}>
        <span><i className={`user-avatar ${item.is_developer ? 'developer' : ''}`}>{item.is_developer ? <Code2 size={15}/> : item.name[0]}</i><b>{item.name}<small>{item.email}</small></b></span>
        <span><em className={`role role-${item.role}`}>{roleLabel(item.role)}</em></span>
        <span><i className={`active-dot ${item.active ? '' : 'off'}`}/>{item.active ? 'Активен' : 'Отключён'}</span>
        <span>{dateTime(item.created_at)}</span>
        <span>{manageable && <button onClick={() => setEditing(item)} aria-label={`Изменить ${item.name}`}><UserPen size={17}/></button>}</span>
      </div>)}
    </section>
    {editing && <UserModal item={editing} catalog={catalog} granular={granular} onClose={() => setEditing(null)} onSave={save}/>}
  </div>
}

function RoleCard({ role, icon, title, text }) {
  return <div className={`role-card ${role}`}>{icon || <ShieldCheck/>}<div><strong>{title}</strong><span>{text}</span></div></div>
}

function UserModal({ item, catalog, granular, onClose, onSave }) {
  const [form, setForm] = useState({
    name: '', email: '', role: 'viewer', password: '', active: true,
    permissions: catalog.presets.viewer || {}, ...item,
  })
  const setRole = role => setForm(current => ({
    ...current,
    role,
    permissions: granular ? { ...(catalog.presets[role] || {}) } : current.permissions,
  }))
  const togglePermission = key => {
    const group = catalog.groups.find(candidate => candidate.permissions.some(permission => permission.key === key))
    const nextEnabled = !form.permissions?.[key]
    setForm(current => {
      const permissions = { ...current.permissions, [key]: nextEnabled }
      const viewKey = group?.permissions.find(permission => permission.key.endsWith('.view'))?.key
      if (!nextEnabled && key === viewKey) group.permissions.forEach(permission => { permissions[permission.key] = false })
      if (nextEnabled && viewKey) permissions[viewKey] = true
      if (nextEnabled && key === 'credits.view') permissions['registry.view'] = true
      return { ...current, permissions }
    })
  }
  const toggleGroup = group => {
    const enable = group.permissions.some(permission => !form.permissions?.[permission.key])
    setForm(current => ({
      ...current,
      permissions: {
        ...current.permissions,
        ...Object.fromEntries(group.permissions.map(permission => [permission.key, enable])),
      },
    }))
  }
  return <div className="modal-backdrop">
    <form className="modal user-access-modal" onSubmit={event => { event.preventDefault(); onSave(form) }}>
      <div className="modal-head">
        <div><p className="eyebrow">Доступ к системе</p><h2>{item.id ? 'Пользователь и права' : 'Новый пользователь'}</h2></div>
        <button type="button" onClick={onClose}><X/></button>
      </div>
      <div className="user-access-body">
        <section className="user-account-fields">
          <label className="field"><span>Имя</span><input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
          {!item.id && <label className="field"><span>Электронная почта</span><input required type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })}/></label>}
          <label className="field"><span>Базовый профиль</span>
            <select value={form.is_developer ? 'developer' : form.role} disabled={form.is_developer} onChange={event => setRole(event.target.value)}>
              {form.is_developer && <option value="developer">Программист</option>}
              <option value="admin">Администратор</option><option value="editor">Редактор</option><option value="viewer">Зритель</option>
            </select>
          </label>
          <label className="field"><span>{item.id ? 'Новый пароль (необязательно)' : 'Пароль'}</span><input type="password" required={!item.id} minLength="8" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })}/></label>
          {item.id && <label className={`switch-row ${form.is_developer ? 'is-locked' : ''}`}><input type="checkbox" checked={form.active} disabled={form.is_developer} onChange={event => setForm({ ...form, active: event.target.checked })}/><i/><span>Учётная запись активна</span></label>}
          {form.is_developer && <div className="developer-lock-note"><Code2 size={18}/><span><strong>Защищённая роль</strong>Права программиста всегда включены и не могут быть сняты.</span></div>}
        </section>
        {granular && !form.is_developer && <section className="permission-editor">
          <header><div><strong>Индивидуальные права</strong><span>Галочки применяются сразу после сохранения</span></div><small>{Object.values(form.permissions || {}).filter(Boolean).length} включено</small></header>
          <div className="permission-groups">
            {catalog.groups.map(group => {
              const enabled = group.permissions.filter(permission => form.permissions?.[permission.key]).length
              return <article className="permission-group" key={group.key}>
                <button type="button" className="permission-group-title" onClick={() => toggleGroup(group)}>
                  <span className={`permission-checkbox ${enabled === group.permissions.length ? 'checked' : enabled ? 'mixed' : ''}`}>{enabled > 0 && <Check size={14}/>}</span>
                  <strong>{group.label}</strong><small>{enabled}/{group.permissions.length}</small>
                </button>
                <div>{group.permissions.map(permission => <label key={permission.key}>
                  <input type="checkbox" checked={Boolean(form.permissions?.[permission.key])} onChange={() => togglePermission(permission.key)}/>
                  <i><Check size={12}/></i><span>{permission.label}</span>
                </label>)}</div>
              </article>
            })}
          </div>
        </section>}
      </div>
      <div className="modal-footer"><button type="button" className="secondary" onClick={onClose}>Отмена</button><button className="primary">Сохранить</button></div>
    </form>
  </div>
}
