import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileUp, Filter, LocateFixed, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, roleLabel, shortDate } from './App'
import usePresence from './usePresence'

const emptyFilters = { q: '', counterparty: '', account_type: '', legal_entity: '', cost_category: '', priority: '', responsible: '', status: '', urgency: '', planned_from: '', planned_to: '', overdue: '' }
const dateFields = new Set(['entry_date', 'document_date', 'planned_payment_date', 'approval_date', 'actual_payment_date'])
const fieldLabels = { counterparty: 'Контрагент', entry_date: 'Дата внесения', document_number: 'Документ', document_date: 'Дата документа', legal_entity: 'Юрлицо', cost_category: 'Статья затрат', amount: 'Сумма, ₽', deferment_days: 'Отсрочка, дней', planned_payment_date: 'Плановая оплата', approval_date: 'Дата утверждения', actual_payment_date: 'Фактическая оплата', status: 'Статус', urgency: 'Срочность', responsible: 'Ответственный', priority: 'Приоритет', account_type: 'Признак учёта', comment: 'Комментарий', source_note: 'Условия оплаты' }
const registryColumnWidths = [46, 220, 130, 180, 135, 180, 240, 120, 110, 145, 145, 145, 160, 135, 160, 120, 130, 240, 240, 52]

export default function Registry({ user, notify }) {
  const [data, setData] = useState({ items: [], total: 0, page: 1, page_size: 50 })
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(emptyFilters)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState({ key: 'updated_at', order: 'desc' })
  const [loading, setLoading] = useState(true)
  const [newRow, setNewRow] = useState(null)
  const [savingCells, setSavingCells] = useState(new Set())
  const [selected, setSelected] = useState([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const importRef = useRef()
  const rowsRef = useRef(new Map())
  const saveQueues = useRef(new Map())
  const creatingRef = useRef(false)
  const { activeUsers, updateLocation, sessionId } = usePresence({ page: 'registry', page_label: 'Реестр обязательств', mode: 'view' })

  useEffect(() => { Promise.all([request('/api/references'), request('/api/saved-view')]).then(([r, saved]) => { setRefs(r); if (saved && Object.keys(saved).length) setFilters({ ...emptyFilters, ...saved }) }).catch(e => notify(e.message, 'error')) }, [])
  const query = useMemo(() => { const params = new URLSearchParams({ page, page_size: 50, sort: sort.key, order: sort.order }); Object.entries(filters).forEach(([k, v]) => v && params.set(k, v)); return params.toString() }, [filters, page, sort])
  const load = () => { setLoading(true); request(`/api/obligations?${query}`).then(result => { rowsRef.current = new Map(result.items.map(item => [item.id, item])); setData(result) }).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  useEffect(() => { const timer = setTimeout(load, 220); return () => clearTimeout(timer) }, [query])
  useEffect(() => { const timer = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(filters) }).catch(() => {}), 700); return () => clearTimeout(timer) }, [filters])
  const setFilter = (key, value) => { setFilters(old => ({ ...old, [key]: value })); setPage(1) }
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const allSelected = data.items.length > 0 && data.items.every(item => selected.includes(item.id))
  const toggleAll = () => setSelected(allSelected ? selected.filter(id => !data.items.some(i => i.id === id)) : [...new Set([...selected, ...data.items.map(i => i.id)])])
  const markSaving = (key, active) => setSavingCells(current => { const next = new Set(current); active ? next.add(key) : next.delete(key); return next })
  const startCellEdit = (item, field) => updateLocation({ mode: 'edit', record_id: item.id || 0, source_row: item.source_row || 0, field, field_label: fieldLabels[field] || field })
  const finishCellEdit = item => updateLocation({ mode: 'view', record_id: item.id || 0, source_row: item.source_row || 0, field: '', field_label: '' })
  const commitCell = async (item, field, rawValue) => {
    let value
    try { value = normalizeCellValue(field, rawValue) } catch (error) { notify(error.message, 'error'); return false }
    const current = rowsRef.current.get(item.id) || item
    if (sameCellValue(current[field], value)) { finishCellEdit(current); return true }
    const previousValue = current[field]
    const next = { ...current, [field]: value }
    rowsRef.current.set(item.id, next)
    setData(state => ({ ...state, items: state.items.map(row => row.id === item.id ? next : row) }))
    const cellKey = `${item.id}:${field}`
    markSaving(cellKey, true); finishCellEdit(next)
    const previousSave = saveQueues.current.get(item.id) || Promise.resolve()
    const operation = previousSave.catch(() => {}).then(() => request(`/api/obligations/${item.id}`, { method: 'PATCH', body: JSON.stringify(strip(rowsRef.current.get(item.id))) }))
    saveQueues.current.set(item.id, operation)
    try { await operation; return true } catch (error) {
      const latest = rowsRef.current.get(item.id)
      if (sameCellValue(latest?.[field], value)) {
        const reverted = { ...latest, [field]: previousValue }
        rowsRef.current.set(item.id, reverted)
        setData(state => ({ ...state, items: state.items.map(row => row.id === item.id ? reverted : row) }))
      }
      notify(error.message, 'error'); return false
    } finally { markSaving(cellKey, false) }
  }
  const addInlineRow = () => setNewRow(current => current ? null : blankObligation())
  const commitNewCell = async (item, field, rawValue) => {
    let value
    try { value = normalizeCellValue(field, rawValue) } catch (error) { notify(error.message, 'error'); return false }
    const next = { ...item, [field]: value }
    setNewRow(next)
    if (sameCellValue(item[field], value) || creatingRef.current) return true
    creatingRef.current = true; markSaving(`new:${field}`, true)
    try {
      const result = await request('/api/obligations', { method: 'POST', body: JSON.stringify(strip(next)) })
      const created = { ...next, id: result.id, source_row: 0, overdue: false, due_soon: false }
      rowsRef.current.set(created.id, created)
      setData(state => ({ ...state, items: [created, ...state.items].slice(0, state.page_size), total: state.total + 1 }))
      setNewRow(null); finishCellEdit(created); notify('Новая строка создана')
      return true
    } catch (error) { notify(error.message, 'error'); return false }
    finally { creatingRef.current = false; markSaving(`new:${field}`, false) }
  }
  const remove = async id => { if (!confirm('Удалить обязательство? Отменить это действие нельзя.')) return; try { await request(`/api/obligations/${id}`, { method: 'DELETE' }); notify('Запись удалена'); load() } catch (e) { notify(e.message, 'error') } }
  const importFile = async event => { const file = event.target.files?.[0]; if (!file) return; const body = new FormData(); body.append('file', file); try { const result = await request('/api/obligations/import.xlsx', { method: 'POST', body }); notify(`Импортировано строк: ${result.imported}`); load() } catch (e) { notify(e.message, 'error') } finally { event.target.value = '' } }
  const doSort = key => setSort(current => ({ key, order: current.key === key && current.order === 'asc' ? 'desc' : 'asc' }))
  return <div className="page registry-page">
    <PageHeader eyebrow="Рабочая область" title="Реестр обязательств" subtitle={`${data.total.toLocaleString('ru-RU')} записей с учётом фильтров`} actions={<><PresenceCluster users={activeUsers} currentSession={sessionId}/>{user.role === 'admin' && <><input ref={importRef} type="file" accept=".xlsx" hidden onChange={importFile}/><button className="secondary" onClick={() => importRef.current.click()}><FileUp size={17}/>Импорт</button></>}<button className="secondary" onClick={() => download(`/api/obligations/export.xlsx?${query}`, 'Реестр обязательств.xlsx')}><Download size={17}/>Excel</button></>}/>
    <section className="filter-panel">
      <div className="search-box"><Search size={18}/><input placeholder="Контрагент, счёт, комментарий…" value={filters.q} onChange={e => setFilter('q', e.target.value)}/>{filters.q && <button onClick={() => setFilter('q', '')}><X size={15}/></button>}</div>
      <label className="filter-date"><span>Срок с</span><DateInput value={filters.planned_from} onChange={value => setFilter('planned_from', value)} aria-label="Срок с"/></label>
      <label className="filter-date"><span>по</span><DateInput value={filters.planned_to} onChange={value => setFilter('planned_to', value)} aria-label="Срок по"/></label>
      <button className={`overdue-toggle ${filters.overdue ? 'active' : ''}`} onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}><Filter size={15}/>Только просроченные</button>
      {Object.values(filters).some(Boolean) && <button className="reset-filters" onClick={() => { setFilters(emptyFilters); setPage(1) }}><RotateCcw size={15}/>Сбросить</button>}
    </section>
    <section className="table-card">
      {selected.length > 0 && <div className="selection-bar"><span><Check size={16}/>{selected.length} выбрано</span>{user.role !== 'viewer' && <button onClick={() => setBulkOpen(true)}>Изменить статус и даты</button>}<button onClick={() => setSelected([])}>Снять выбор</button></div>}
      <div className="registry-table-wrap"><table className="registry-table inline-registry"><colgroup>{registryColumnWidths.map((width, index) => <col key={index} style={{ width }}/>)}</colgroup><thead><tr><th className="check-col">{user.role !== 'viewer' ? <button type="button" className={`inline-add-row ${newRow ? 'active' : ''}`} onClick={addInlineRow} title={newRow ? 'Убрать новую строку' : 'Добавить строку'} aria-label={newRow ? 'Убрать новую строку' : 'Добавить строку'}><Plus size={16}/></button> : <input type="checkbox" checked={allSelected} onChange={toggleAll}/>}</th>
        <ColumnHead label="Контрагент" field="counterparty" sort={sort} onSort={doSort} value={filters.counterparty} options={refs.counterparties} onFilter={value => setFilter('counterparty', value)}/>
        <ColumnHead label="Дата внесения" field="entry_date" sort={sort} onSort={doSort}/>
        <th>Документ</th><th>Дата документа</th>
        <ColumnHead label="Юрлицо" field="legal_entity" sort={sort} onSort={doSort} value={filters.legal_entity} options={refs.legal_entities} onFilter={value => setFilter('legal_entity', value)}/>
        <ColumnHead label="Статья затрат" value={filters.cost_category} options={refs.cost_categories} onFilter={value => setFilter('cost_category', value)}/>
        <ColumnHead label="Сумма" field="amount" sort={sort} onSort={doSort}/>
        <th>Отсрочка, дней</th>
        <ColumnHead label="Плановая оплата" field="planned_payment_date" sort={sort} onSort={doSort}/>
        <ColumnHead label="Дата утверждения" field="approval_date" sort={sort} onSort={doSort}/>
        <th>Фактическая оплата</th>
        <ColumnHead label="Статус" field="status" sort={sort} onSort={doSort} value={filters.status} options={refs.statuses} onFilter={value => setFilter('status', value)}/>
        <ColumnHead label="Срочность" value={filters.urgency} options={refs.urgencies} onFilter={value => setFilter('urgency', value)}/>
        <ColumnHead label="Ответственный" value={filters.responsible} options={refs.responsibles} onFilter={value => setFilter('responsible', value)}/>
        <ColumnHead label="Приоритет" value={filters.priority} options={refs.priorities} onFilter={value => setFilter('priority', value)}/>
        <ColumnHead label="Признак" value={filters.account_type} options={refs.account_types} onFilter={value => setFilter('account_type', value)}/>
        <th>Комментарий</th><th>Условия оплаты</th><th className="action-col"/></tr></thead>
      <tbody>{newRow && <RegistryRow item={newRow} refs={refs} editable isNew savingCells={savingCells} onCommit={commitNewCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onDelete={() => setNewRow(null)}/>} {loading ? <SkeletonRows/> : data.items.length === 0 && !newRow ? <tr><td colSpan="20"><div className="empty-state"><Search size={27}/><strong>Ничего не найдено</strong><span>Измените или сбросьте фильтры</span></div></td></tr> : data.items.map(item => <RegistryRow key={item.id} item={item} refs={refs} editable={user.role !== 'viewer'} selected={selected.includes(item.id)} savingCells={savingCells} onToggle={() => setSelected(s => s.includes(item.id) ? s.filter(id => id !== item.id) : [...s, item.id])} onCommit={commitCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onDelete={user.role === 'admin' ? () => remove(item.id) : null}/>)}</tbody></table></div>
      <footer className="table-footer"><span>Показано {data.items.length} из {data.total.toLocaleString('ru-RU')}</span><div><button disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17}/></button><span>Страница <b>{page}</b> из {totalPages}</span><button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={17}/></button></div></footer>
    </section>
    {bulkOpen && (
      <BulkModal count={selected.length} refs={refs} onClose={() => setBulkOpen(false)} onSave={async values => { try { await request('/api/obligations/bulk', { method: 'POST', body: JSON.stringify({ ids: selected, ...values }) }); notify('Выбранные строки обновлены'); setBulkOpen(false); setSelected([]); load() } catch (e) { notify(e.message, 'error') } }}/>
    )}
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

function RegistryRow({ item, refs, editable, isNew = false, selected, savingCells, onToggle, onCommit, onStartEdit, onFinishEdit, onDelete }) {
  const saving = field => savingCells.has(`${isNew ? 'new' : item.id}:${field}`)
  const cell = (field, props = {}) => <EditableCell item={item} field={field} label={fieldLabels[field]} editable={editable} saving={saving(field)} onCommit={onCommit} onStartEdit={onStartEdit} onFinishEdit={onFinishEdit} {...props}/>
  return <tr className={`${isNew ? 'inline-new-row' : rowTone(item)}`}>
    <td className="check-col">{isNew ? <button type="button" className="cancel-inline-row" onClick={onDelete} title="Отменить новую строку"><X size={14}/></button> : <input type="checkbox" checked={selected} onChange={onToggle}/>}</td>
    {cell('counterparty', { className: 'counterparty-cell', options: refs.counterparties, allowCustom: true })}
    {cell('entry_date', { type: 'date' })}
    {cell('document_number')}
    {cell('document_date', { type: 'date' })}
    {cell('legal_entity', { options: refs.legal_entities })}
    {cell('cost_category', { options: refs.cost_categories, className: 'category-cell' })}
    {cell('amount', { type: 'number', className: 'money-cell', render: value => value == null || value === '' ? '—' : money(value) })}
    {cell('deferment_days', { type: 'number' })}
    {cell('planned_payment_date', { type: 'date', className: item.overdue ? 'date-overdue' : '' })}
    {cell('approval_date', { type: 'date' })}
    {cell('actual_payment_date', { type: 'date' })}
    {cell('status', { options: refs.statuses, render: value => <Status value={value}/> })}
    {cell('urgency', { options: refs.urgencies, render: value => <Urgency value={value}/> })}
    {cell('responsible', { options: refs.responsibles })}
    {cell('priority', { options: refs.priorities })}
    {cell('account_type', { options: refs.account_types })}
    {cell('comment', { className: 'comment-cell' })}
    {cell('source_note', { className: 'comment-cell' })}
    <td className="action-col">{onDelete && !isNew && <div className="row-actions"><button className="danger-button" onClick={onDelete} title="Удалить"><Trash2 size={16}/></button></div>}</td>
  </tr>
}

function EditableCell({ item, field, label, editable, saving, type = 'text', options, allowCustom = false, className = '', render, onCommit, onStartEdit, onFinishEdit }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const begin = () => {
    if (!editable || editing) return
    setDraft(cellEditorValue(field, item[field])); setEditing(true); onStartEdit(item, field)
  }
  const cancel = () => { setEditing(false); onFinishEdit(item) }
  const commit = async () => { const ok = await onCommit(item, field, draft); if (ok) setEditing(false) }
  const keyDown = event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
  }
  const display = render ? render(item[field]) : type === 'date' ? shortDate(item[field]) : (item[field] ?? '') || '—'
  return <td className={`editable-cell ${className} ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`} aria-label={`${label}: ${cellAriaValue(field, item[field])}`} onClick={begin} title={editable && !editing ? `Изменить: ${label}` : undefined}>
    {editing ? options ? <InlineCellSelect label={label} value={item[field] || ''} options={options} allowCustom={allowCustom} onChoose={value => { setDraft(value); onCommit(item, field, value).then(ok => ok && setEditing(false)) }} onCancel={cancel}/> : type === 'date' ? <DateInput className="inline-cell-input" value={item[field] || ''} onChange={value => onCommit(item, field, value).then(ok => ok && setEditing(false))} onClose={() => { setEditing(false); onFinishEdit(item) }} aria-label={label} autoFocus/> : <input className="inline-cell-input" type={type === 'number' ? 'number' : 'text'} placeholder="Введите значение" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} autoFocus/> : <div className="cell-display">{display}</div>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

function InlineCellSelect({ label, value, options = [], allowCustom, onChoose, onCancel }) {
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const values = useMemo(() => [...new Set(options.map(option => typeof option === 'string' ? option : option.value).filter(Boolean))], [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? values.filter(option => option.toLocaleLowerCase('ru-RU').includes(term)) : values }, [search, values])
  useEffect(() => {
    const outside = event => { if (!rootRef.current?.contains(event.target)) onCancel() }
    document.addEventListener('mousedown', outside)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => document.removeEventListener('mousedown', outside)
  }, [])
  const useCustom = search.trim() && !values.some(option => option.toLocaleLowerCase('ru-RU') === search.trim().toLocaleLowerCase('ru-RU'))
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    if (event.key === 'Enter') { event.preventDefault(); const next = visible[0] || (allowCustom ? search.trim() : ''); if (next) onChoose(next) }
  }
  return <div ref={rootRef} className="inline-select-menu" onClick={event => event.stopPropagation()}>
    <div className="inline-select-search"><Search size={14}/><input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={keyDown} placeholder="Поиск по наименованию" aria-label={`Поиск значения: ${label}`}/></div>
    <div className="inline-select-options">
      <button type="button" className={!value ? 'selected' : ''} onClick={() => onChoose('')}><span>Не выбрано</span>{!value && <Check size={13}/>}</button>
      {allowCustom && useCustom && <button type="button" className="custom-value" onClick={() => onChoose(search.trim())}><span>Использовать «{search.trim()}»</span><Plus size={13}/></button>}
      {visible.map(option => <button type="button" key={option} className={option === value ? 'selected' : ''} onClick={() => onChoose(option)} title={option}><span>{option}</span>{option === value && <Check size={13}/>}</button>)}
      {!visible.length && !(allowCustom && useCustom) && <p>Ничего не найдено</p>}
    </div>
  </div>
}

function Status({ value }) { return <span className={`status status-${slug(value)}`}>{value || 'Не указан'}</span> }
function Urgency({ value }) { return value ? <span className={`urgency urgency-${slug(value)}`}><i/>{value}</span> : <span className="muted">—</span> }
function slug(value = '') { return ({ 'Оплачено':'paid','К оплате':'to-pay','Зарегистрирован':'registered','Частично оплачено':'partial','Отменено':'cancelled','Критическая':'critical','Срочная':'urgent','Обычная':'normal' }[value] || 'empty') }
function rowTone(item) { return item.overdue ? 'row-overdue' : item.due_soon ? 'row-soon' : item.status === 'К оплате' ? 'row-to-pay' : '' }
function SkeletonRows() { return <>{Array.from({ length: 8 }).map((_, i) => <tr className="skeleton-row" key={i}>{Array.from({ length: 20 }).map((__, j) => <td key={j}><i/></td>)}</tr>)}</> }
function strip(values) { const result = { ...values }; delete result.id; delete result.created_at; delete result.updated_at; delete result.overdue; delete result.due_soon; return result }
function blankObligation() { return { account_type:'',entry_date:todayISO(),counterparty:'',legal_entity:'',cost_category:'',priority:'',responsible:'',document_number:'',deferment_days:null,document_date:'',amount:null,planned_payment_date:'',approval_date:'',actual_payment_date:'',status:'Зарегистрирован',urgency:'',comment:'',source_note:'' } }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function sameCellValue(left, right) { return (left ?? '') === (right ?? '') }
function cellEditorValue(field, value) { if (dateFields.has(field)) return value ? shortDate(value) : ''; return value ?? '' }
function cellAriaValue(field, value) { if (dateFields.has(field)) return shortDate(value); if (field === 'amount' && value != null && value !== '') return money(value); return String(value ?? '') || 'не заполнено' }
function normalizeCellValue(field, rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue
  if (dateFields.has(field)) return parseInlineDate(value)
  if (field === 'amount') { if (value === '') return null; const number = Number(String(value).replace(',', '.')); if (!Number.isFinite(number)) throw new Error('Введите корректную сумму'); return number }
  if (field === 'deferment_days') { if (value === '') return null; const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new Error('Отсрочка должна быть целым числом'); return number }
  return value
}
function parseInlineDate(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = String(value).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (!match) throw new Error('Введите дату в формате дд/мм/гггг')
  const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Введите корректную дату')
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

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

function Field({ label, fieldKey, value, onChange, onFocus, wide, type, ...props }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{type === 'date' ? <DateInput value={value ?? ''} onChange={onChange} onFocus={() => onFocus?.(fieldKey, label)} {...props}/> : <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)} {...props}/>}</label> }
function SelectField({ label, fieldKey, value, options = [], onChange, onFocus, wide, editable }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{editable ? <><input list={`list-${label}`} value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}/><datalist id={`list-${label}`}>{options.map(o => <option key={o.id ?? o.value} value={o.value}/>)}</datalist></> : <select value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}><option value="">Не выбрано</option>{options.map(o => <option key={o.id ?? o.value} value={o.value}>{o.value}</option>)}</select>}</label> }
function BulkModal({ count, refs, onClose, onSave }) { const [form,setForm]=useState({status:'',approval_date:'',actual_payment_date:''});return <div className="modal-backdrop"><div className="modal small-modal"><div className="modal-head"><div><p className="eyebrow">Массовое действие</p><h2>Изменить {count} строк</h2></div><button onClick={onClose}><X/></button></div><div className="modal-body stacked-fields"><SelectField label="Новый статус" value={form.status} options={refs.statuses} onChange={v=>setForm({...form,status:v})}/><Field label="Дата утверждения" type="date" value={form.approval_date} onChange={v=>setForm({...form,approval_date:v})}/><Field label="Фактическая дата оплаты" type="date" value={form.actual_payment_date} onChange={v=>setForm({...form,actual_payment_date:v})}/></div><div className="modal-footer"><button className="secondary" onClick={onClose}>Отмена</button><button className="primary" onClick={()=>onSave(form)}>Применить</button></div></div></div> }
