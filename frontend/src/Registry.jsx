import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileUp, Filter, LocateFixed, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { download, request } from './api'
import { money, PageHeader, roleLabel, shortDate } from './App'
import usePresence from './usePresence'

const emptyFilters = { q: '', counterparty: '', account_type: '', legal_entity: '', cost_category: '', priority: '', responsible: '', status: '', urgency: '', planned_from: '', planned_to: '', overdue: '' }
export default function Registry({ user, notify }) {
  const [data, setData] = useState({ items: [], total: 0, page: 1, page_size: 50 })
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(emptyFilters)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState({ key: 'updated_at', order: 'desc' })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [selected, setSelected] = useState([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const importRef = useRef()
  const { activeUsers, updateLocation, sessionId } = usePresence({ page: 'registry', page_label: 'Реестр обязательств', mode: 'view' })

  useEffect(() => { Promise.all([request('/api/references'), request('/api/saved-view')]).then(([r, saved]) => { setRefs(r); if (saved && Object.keys(saved).length) setFilters({ ...emptyFilters, ...saved }) }).catch(e => notify(e.message, 'error')) }, [])
  const query = useMemo(() => { const params = new URLSearchParams({ page, page_size: 50, sort: sort.key, order: sort.order }); Object.entries(filters).forEach(([k, v]) => v && params.set(k, v)); return params.toString() }, [filters, page, sort])
  const load = () => { setLoading(true); request(`/api/obligations?${query}`).then(setData).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  useEffect(() => { const timer = setTimeout(load, 220); return () => clearTimeout(timer) }, [query])
  useEffect(() => { const timer = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(filters) }).catch(() => {}), 700); return () => clearTimeout(timer) }, [filters])
  useLayoutEffect(() => {
    if (editing) updateLocation({ mode: 'view', record_id: editing.id || 0, source_row: editing.source_row || 0, field: '', field_label: '' })
    else updateLocation({ mode: 'view', record_id: 0, source_row: 0, field: '', field_label: '' })
  }, [editing, updateLocation])
  const setFilter = (key, value) => { setFilters(old => ({ ...old, [key]: value })); setPage(1) }
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const allSelected = data.items.length > 0 && data.items.every(item => selected.includes(item.id))
  const toggleAll = () => setSelected(allSelected ? selected.filter(id => !data.items.some(i => i.id === id)) : [...new Set([...selected, ...data.items.map(i => i.id)])])
  const save = async values => { try { if (values.id) await request(`/api/obligations/${values.id}`, { method: 'PATCH', body: JSON.stringify(strip(values)) }); else await request('/api/obligations', { method: 'POST', body: JSON.stringify(strip(values)) }); notify(values.id ? 'Изменения сохранены' : 'Обязательство добавлено'); setEditing(null); load() } catch (e) { notify(e.message, 'error') } }
  const remove = async id => { if (!confirm('Удалить обязательство? Отменить это действие нельзя.')) return; try { await request(`/api/obligations/${id}`, { method: 'DELETE' }); notify('Запись удалена'); load() } catch (e) { notify(e.message, 'error') } }
  const importFile = async event => { const file = event.target.files?.[0]; if (!file) return; const body = new FormData(); body.append('file', file); try { const result = await request('/api/obligations/import.xlsx', { method: 'POST', body }); notify(`Импортировано строк: ${result.imported}`); load() } catch (e) { notify(e.message, 'error') } finally { event.target.value = '' } }
  const doSort = key => setSort(current => ({ key, order: current.key === key && current.order === 'asc' ? 'desc' : 'asc' }))
  return <div className="page registry-page">
    <PageHeader eyebrow="Рабочая область" title="Реестр обязательств" subtitle={`${data.total.toLocaleString('ru-RU')} записей с учётом фильтров`} actions={<><PresenceCluster users={activeUsers} currentSession={sessionId}/>{user.role === 'admin' && <><input ref={importRef} type="file" accept=".xlsx" hidden onChange={importFile}/><button className="secondary" onClick={() => importRef.current.click()}><FileUp size={17}/>Импорт</button></>}<button className="secondary" onClick={() => download(`/api/obligations/export.xlsx?${query}`, 'Реестр обязательств.xlsx')}><Download size={17}/>Excel</button>{user.role !== 'viewer' && <button className="primary" onClick={() => setEditing({})}><Plus size={18}/>Добавить</button>}</>}/>
    <section className="filter-panel">
      <div className="search-box"><Search size={18}/><input placeholder="Контрагент, счёт, комментарий…" value={filters.q} onChange={e => setFilter('q', e.target.value)}/>{filters.q && <button onClick={() => setFilter('q', '')}><X size={15}/></button>}</div>
      <label className="filter-date"><span>Срок с</span><input type="date" value={filters.planned_from} onChange={e => setFilter('planned_from', e.target.value)}/></label>
      <label className="filter-date"><span>по</span><input type="date" value={filters.planned_to} onChange={e => setFilter('planned_to', e.target.value)}/></label>
      <button className={`overdue-toggle ${filters.overdue ? 'active' : ''}`} onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}><Filter size={15}/>Только просроченные</button>
      {Object.values(filters).some(Boolean) && <button className="reset-filters" onClick={() => { setFilters(emptyFilters); setPage(1) }}><RotateCcw size={15}/>Сбросить</button>}
    </section>
    <section className="table-card">
      {selected.length > 0 && <div className="selection-bar"><span><Check size={16}/>{selected.length} выбрано</span>{user.role !== 'viewer' && <button onClick={() => setBulkOpen(true)}>Изменить статус и даты</button>}<button onClick={() => setSelected([])}>Снять выбор</button></div>}
      <div className="registry-table-wrap"><table className="registry-table"><thead><tr><th className="check-col"><input type="checkbox" checked={allSelected} onChange={toggleAll}/></th>
        <ColumnHead label="Контрагент" field="counterparty" sort={sort} onSort={doSort} value={filters.counterparty} options={refs.counterparties} onFilter={value => setFilter('counterparty', value)}/>
        <th>Документ</th>
        <ColumnHead label="Юрлицо" field="legal_entity" sort={sort} onSort={doSort} value={filters.legal_entity} options={refs.legal_entities} onFilter={value => setFilter('legal_entity', value)}/>
        <ColumnHead label="Статья затрат" value={filters.cost_category} options={refs.cost_categories} onFilter={value => setFilter('cost_category', value)}/>
        <ColumnHead label="Сумма" field="amount" sort={sort} onSort={doSort}/>
        <ColumnHead label="Плановая оплата" field="planned_payment_date" sort={sort} onSort={doSort}/>
        <ColumnHead label="Статус" field="status" sort={sort} onSort={doSort} value={filters.status} options={refs.statuses} onFilter={value => setFilter('status', value)}/>
        <ColumnHead label="Срочность" value={filters.urgency} options={refs.urgencies} onFilter={value => setFilter('urgency', value)}/>
        <ColumnHead label="Ответственный" value={filters.responsible} options={refs.responsibles} onFilter={value => setFilter('responsible', value)}/>
        <ColumnHead label="Приоритет" value={filters.priority} options={refs.priorities} onFilter={value => setFilter('priority', value)}/>
        <ColumnHead label="Признак" value={filters.account_type} options={refs.account_types} onFilter={value => setFilter('account_type', value)}/>
        <th>Комментарий</th><th className="action-col"/></tr></thead>
      <tbody>{loading ? <SkeletonRows/> : data.items.length === 0 ? <tr><td colSpan="14"><div className="empty-state"><Search size={27}/><strong>Ничего не найдено</strong><span>Измените или сбросьте фильтры</span></div></td></tr> : data.items.map(item => <tr key={item.id} className={rowTone(item)}><td className="check-col"><input type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected(s => s.includes(item.id) ? s.filter(id => id !== item.id) : [...s, item.id])}/></td><td className="counterparty-cell"><strong>{item.counterparty || '—'}</strong><span>{shortDate(item.entry_date)}</span></td><td title={item.source_note || ''}><span className="doc-number">{item.document_number || '—'}{item.source_note && <i className="note-mark">i</i>}</span><small>{shortDate(item.document_date)}</small>{item.source_note && <small className="source-note">{item.source_note}</small>}</td><td>{item.legal_entity || '—'}</td><td className="category-cell">{item.cost_category || '—'}</td><td className="money-cell">{money(item.amount)}</td><td><span className={item.overdue ? 'date-overdue' : ''}>{shortDate(item.planned_payment_date)}</span>{item.deferment_days != null && <small>отсрочка {item.deferment_days} дн.</small>}</td><td><Status value={item.status}/></td><td><Urgency value={item.urgency}/></td><td>{item.responsible || '—'}</td><td><span className="priority">{item.priority || '—'}</span></td><td>{item.account_type || '—'}</td><td className="comment-cell" title={item.comment}>{item.comment || '—'}</td><td className="action-col">{user.role !== 'viewer' ? <div className="row-actions"><button onClick={() => setEditing(item)} title="Редактировать"><Pencil size={16}/></button>{user.role === 'admin' && <button className="danger-button" onClick={() => remove(item.id)} title="Удалить"><Trash2 size={16}/></button>}</div> : <MoreHorizontal size={18}/>}</td></tr>)}</tbody></table></div>
      <footer className="table-footer"><span>Показано {data.items.length} из {data.total.toLocaleString('ru-RU')}</span><div><button disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17}/></button><span>Страница <b>{page}</b> из {totalPages}</span><button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={17}/></button></div></footer>
    </section>
    {editing && <ObligationModal item={editing} refs={refs} onClose={() => setEditing(null)} onSave={save} onFieldFocus={(field, fieldLabel) => updateLocation({ mode: 'edit', record_id: editing.id || 0, source_row: editing.source_row || 0, field, field_label: fieldLabel })}/>}
    {bulkOpen && <BulkModal count={selected.length} refs={refs} onClose={() => setBulkOpen(false)} onSave={async values => { try { await request('/api/obligations/bulk', { method: 'POST', body: JSON.stringify({ ids: selected, ...values }) }); notify('Выбранные строки обновлены'); setBulkOpen(false); setSelected([]); load() } catch (e) { notify(e.message, 'error') } }}/>}
  </div>
}

function ColumnHead({ label, field, sort, onSort, value = '', options, onFilter }) {
  const sorted = field && sort?.key === field
  return <th className={`${sorted ? 'sorted' : ''} ${value ? 'filtered' : ''}`}><div className="column-head-inner">
    {field ? <button type="button" className="column-sort" onClick={() => onSort(field)}>{label}<i>{sorted ? (sort.order === 'asc' ? '↑' : '↓') : '↕'}</i></button> : <span className="column-label">{label}</span>}
    {onFilter && <HeaderFilter label={label} value={value} options={options} onChange={onFilter}/>}
  </div></th>
}

function HeaderFilter({ label, value, options = [], onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const values = useMemo(() => [...new Set(options.map(option => typeof option === 'string' ? option : option.value).filter(Boolean))], [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? values.filter(option => option.toLocaleLowerCase('ru-RU').includes(term)) : values }, [search, values])
  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])
  const select = next => { onChange(next); setSearch(''); setOpen(false) }
  return <div ref={rootRef} className={`header-filter ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
    <button type="button" className="header-filter-trigger" aria-label={`Фильтр: ${label}`} aria-expanded={open} onClick={() => { setSearch(''); setOpen(current => !current) }}><ChevronDown size={13}/>{value && <i/>}</button>
    {open && <div className="header-filter-menu">
      <div className="header-filter-search"><Search size={15}/><input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по наименованию" aria-label={`Поиск: ${label}`}/>{search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={13}/></button>}</div>
      <div className="header-filter-options" role="listbox" aria-label={`Значения: ${label}`}>
        <button type="button" className={!value ? 'selected' : ''} onClick={() => select('')}><span>Все значения</span>{!value && <Check size={14}/>}</button>
        {visible.map(option => <button type="button" key={option} className={option === value ? 'selected' : ''} onClick={() => select(option)} title={option}><span>{option}</span>{option === value && <Check size={14}/>}</button>)}
        {!visible.length && <p>Ничего не найдено</p>}
      </div>
    </div>}
  </div>
}
function Status({ value }) { return <span className={`status status-${slug(value)}`}>{value || 'Не указан'}</span> }
function Urgency({ value }) { return value ? <span className={`urgency urgency-${slug(value)}`}><i/>{value}</span> : <span className="muted">—</span> }
function slug(value = '') { return ({ 'Оплачено':'paid','К оплате':'to-pay','Зарегистрирован':'registered','Частично оплачено':'partial','Отменено':'cancelled','Критическая':'critical','Срочная':'urgent','Обычная':'normal' }[value] || 'empty') }
function rowTone(item) { return item.overdue ? 'row-overdue' : item.due_soon ? 'row-soon' : item.status === 'К оплате' ? 'row-to-pay' : '' }
function SkeletonRows() { return <>{Array.from({ length: 8 }).map((_, i) => <tr className="skeleton-row" key={i}>{Array.from({ length: 14 }).map((__, j) => <td key={j}><i/></td>)}</tr>)}</> }
function strip(values) { const result = { ...values }; delete result.id; delete result.created_at; delete result.updated_at; delete result.overdue; delete result.due_soon; return result }

function PresenceCluster({ users, currentSession }) {
  const [selectedSession, setSelectedSession] = useState(null)
  const selected = users.find(user => user.session_id === selectedSession)
  useEffect(() => { if (selectedSession && !selected) setSelectedSession(null) }, [selectedSession, selected])
  if (!users.length) return <div className="presence-loading" title="Подключаем совместную работу"><i/></div>
  const visible = users.slice(0, 5)
  return <div className="presence-cluster">
    <div className="presence-avatars" aria-label={`Активных пользователей: ${users.length}`}>
      {visible.map(person => <button key={person.session_id} type="button" className={`presence-avatar ${person.mode === 'edit' ? 'is-editing' : ''}`} style={{ '--presence-color': person.color }} data-tooltip={`${person.name}${person.session_id === currentSession ? ' (вы)' : ''}`} aria-label={`${person.name}: ${presenceLocation(person)}`} onClick={() => setSelectedSession(selectedSession === person.session_id ? null : person.session_id)}><span>{initials(person.name)}</span><i/></button>)}
      {users.length > visible.length && <span className="presence-more">+{users.length - visible.length}</span>}
    </div>
    {selected && <div className="presence-popover">
      <div className="presence-popover-head"><span className="presence-avatar static" style={{ '--presence-color': selected.color }}><span>{initials(selected.name)}</span></span><div><strong>{selected.name}{selected.session_id === currentSession ? ' · вы' : ''}</strong><small>{roleLabel(selected.role)}</small></div><button type="button" onClick={() => setSelectedSession(null)}><X size={15}/></button></div>
      <div className="presence-location"><LocateFixed size={17}/><div><span>{selected.mode === 'edit' ? 'Сейчас редактирует' : 'Сейчас просматривает'}</span><strong>{presenceLocation(selected)}</strong>{selected.mode === 'edit' && selected.field_label && <small>Поле: «{selected.field_label}»</small>}</div></div>
      <p>Данные обновляются в реальном времени</p>
    </div>}
  </div>
}

function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?' }
function presenceLocation(person) {
  if (person.mode !== 'edit') return 'Реестр обязательств'
  if (!person.record_id) return 'Новое обязательство'
  return person.source_row ? `Строка ${person.source_row} · запись №${person.record_id}` : `Запись №${person.record_id}`
}

function ObligationModal({ item, refs, onClose, onSave, onFieldFocus }) {
  const [form, setForm] = useState({ account_type:'',entry_date:new Date().toISOString().slice(0,10),counterparty:'',legal_entity:'',cost_category:'',priority:'',responsible:'',document_number:'',deferment_days:'',document_date:'',amount:'',planned_payment_date:'',approval_date:'',actual_payment_date:'',status:'Зарегистрирован',urgency:'',comment:'',source_note:'',...item })
  const set = (key, value) => setForm(old => ({ ...old, [key]: value }))
  useEffect(() => { if (form.document_date && form.deferment_days !== '' && !item.id) { const d = new Date(`${form.document_date}T00:00:00`); d.setDate(d.getDate() + Number(form.deferment_days || 0)); set('planned_payment_date', d.toISOString().slice(0, 10)) } }, [form.document_date, form.deferment_days])
  const submit = e => { e.preventDefault(); onSave({ ...form, deferment_days: form.deferment_days === '' ? null : Number(form.deferment_days), amount: form.amount === '' ? null : Number(form.amount) }) }
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><form className="modal obligation-modal" onSubmit={submit}><div className="modal-head"><div><p className="eyebrow">{item.id ? `Запись №${item.id}` : 'Новая запись'}</p><h2>{item.id ? 'Редактирование обязательства' : 'Новое обязательство'}</h2></div><button type="button" onClick={onClose}><X/></button></div><div className="modal-body form-grid">
    <SelectField label="Признак учёта" fieldKey="account_type" value={form.account_type} options={refs.account_types} onChange={v => set('account_type', v)} onFocus={onFieldFocus}/><Field label="Дата внесения" fieldKey="entry_date" type="date" value={form.entry_date} onChange={v => set('entry_date', v)} onFocus={onFieldFocus}/>
    <SelectField label="Контрагент" fieldKey="counterparty" value={form.counterparty} options={refs.counterparties} editable onChange={v => set('counterparty', v)} onFocus={onFieldFocus} wide/><SelectField label="Юридическое лицо" fieldKey="legal_entity" value={form.legal_entity} options={refs.legal_entities} onChange={v => set('legal_entity', v)} onFocus={onFieldFocus}/>
    <SelectField label="Статья затрат" fieldKey="cost_category" value={form.cost_category} options={refs.cost_categories} onChange={v => set('cost_category', v)} onFocus={onFieldFocus} wide/><SelectField label="Приоритет" fieldKey="priority" value={form.priority} options={refs.priorities} onChange={v => set('priority', v)} onFocus={onFieldFocus}/>
    <SelectField label="Ответственный" fieldKey="responsible" value={form.responsible} options={refs.responsibles} onChange={v => set('responsible', v)} onFocus={onFieldFocus}/><Field label="№ счёта / договора" fieldKey="document_number" value={form.document_number} onChange={v => set('document_number', v)} onFocus={onFieldFocus}/><label className="field wide"><span>Условия оплаты / заметка к документу</span><textarea rows="2" value={form.source_note} onChange={e => set('source_note', e.target.value)} onFocus={() => onFieldFocus?.('source_note', 'Условия оплаты / заметка к документу')} placeholder="Например: отсрочка 30 дней или оплата до 10 числа"/></label>
    <Field label="Дата документа" fieldKey="document_date" type="date" value={form.document_date} onChange={v => set('document_date', v)} onFocus={onFieldFocus}/><Field label="Отсрочка, дней" fieldKey="deferment_days" type="number" value={form.deferment_days ?? ''} onChange={v => set('deferment_days', v)} onFocus={onFieldFocus}/><Field label="Сумма, ₽" fieldKey="amount" type="number" step="0.01" value={form.amount ?? ''} onChange={v => set('amount', v)} onFocus={onFieldFocus} required/><Field label="Плановая дата оплаты" fieldKey="planned_payment_date" type="date" value={form.planned_payment_date} onChange={v => set('planned_payment_date', v)} onFocus={onFieldFocus}/>
    <SelectField label="Статус" fieldKey="status" value={form.status} options={refs.statuses} onChange={v => set('status', v)} onFocus={onFieldFocus}/><SelectField label="Срочность" fieldKey="urgency" value={form.urgency} options={refs.urgencies} onChange={v => set('urgency', v)} onFocus={onFieldFocus}/><Field label="Дата утверждения оплаты" fieldKey="approval_date" type="date" value={form.approval_date} onChange={v => set('approval_date', v)} onFocus={onFieldFocus}/><Field label="Фактическая дата оплаты" fieldKey="actual_payment_date" type="date" value={form.actual_payment_date} onChange={v => set('actual_payment_date', v)} onFocus={onFieldFocus}/><label className="field wide"><span>Комментарий</span><textarea rows="3" value={form.comment} onChange={e => set('comment', e.target.value)} onFocus={() => onFieldFocus?.('comment', 'Комментарий')}/></label>
  </div><div className="modal-footer"><button type="button" className="secondary" onClick={onClose}>Отмена</button><button className="primary">{item.id ? 'Сохранить' : 'Добавить в реестр'}</button></div></form></div>
}
function Field({ label, fieldKey, value, onChange, onFocus, wide, ...props }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span><input value={value ?? ''} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)} {...props}/></label> }
function SelectField({ label, fieldKey, value, options = [], onChange, onFocus, wide, editable }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{editable ? <><input list={`list-${label}`} value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}/><datalist id={`list-${label}`}>{options.map(o => <option key={o.id ?? o.value} value={o.value}/>)}</datalist></> : <select value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}><option value="">Не выбрано</option>{options.map(o => <option key={o.id ?? o.value} value={o.value}>{o.value}</option>)}</select>}</label> }
function BulkModal({ count, refs, onClose, onSave }) { const [form,setForm]=useState({status:'',approval_date:'',actual_payment_date:''});return <div className="modal-backdrop"><div className="modal small-modal"><div className="modal-head"><div><p className="eyebrow">Массовое действие</p><h2>Изменить {count} строк</h2></div><button onClick={onClose}><X/></button></div><div className="modal-body stacked-fields"><SelectField label="Новый статус" value={form.status} options={refs.statuses} onChange={v=>setForm({...form,status:v})}/><Field label="Дата утверждения" type="date" value={form.approval_date} onChange={v=>setForm({...form,approval_date:v})}/><Field label="Фактическая дата оплаты" type="date" value={form.actual_payment_date} onChange={v=>setForm({...form,actual_payment_date:v})}/></div><div className="modal-footer"><button className="secondary" onClick={onClose}>Отмена</button><button className="primary" onClick={()=>onSave(form)}>Применить</button></div></div></div> }
