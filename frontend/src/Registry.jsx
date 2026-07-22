import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileUp, Filter, LocateFixed, Maximize2, Minimize2, Plus, RotateCcw, Scissors, Search, Trash2, X } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, roleLabel, shortDate } from './App'
import usePresence from './usePresence'

const emptyFilters = { q: '', counterparty: [], account_type: '', legal_entity: '', cost_category: '', priority: '', responsible: '', status: '', urgency: '', entry_date: '', document_date: '', planned_payment_date: '', approval_date: '', actual_payment_date: '', planned_from: '', planned_to: '', overdue: '' }
const dateFields = new Set(['entry_date', 'document_date', 'planned_payment_date', 'approval_date', 'actual_payment_date'])
const fieldLabels = { counterparty: 'Контрагент', entry_date: 'Дата внесения', document_number: 'Документ', document_date: 'Дата документа', legal_entity: 'Юрлицо', cost_category: 'Статья затрат', amount: 'Сумма, ₽', deferment_days: 'Отсрочка, дней', planned_payment_date: 'Плановая оплата', approval_date: 'Дата утверждения', actual_payment_date: 'Фактическая оплата', status: 'Статус', urgency: 'Срочность', responsible: 'Ответственный', priority: 'Приоритет', account_type: 'Признак учёта', comment: 'Комментарий', source_note: 'Условия оплаты' }
const registryColumnWidths = [46, 220, 130, 130, 180, 120, 180, 135, 240, 110, 145, 145, 145, 160, 135, 160, 120, 240, 240, 86]
const registryLargeFontKey = 'registry-table-large-font'

function readLargeFontPreference() {
  try { return window.localStorage.getItem(registryLargeFontKey) === 'true' } catch { return false }
}

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
  const [splitItem, setSplitItem] = useState(null)
  const [tableFullscreen, setTableFullscreen] = useState(false)
  const [largeTableFont, setLargeTableFont] = useState(readLargeFontPreference)
  const [viewReady, setViewReady] = useState(false)
  const importRef = useRef()
  const tableWrapRef = useRef()
  const rowsRef = useRef(new Map())
  const saveQueues = useRef(new Map())
  const creatingRef = useRef(false)
  const scrollPositionRef = useRef({ left: 0, top: 0 })
  const scrollSaveTimerRef = useRef()
  const latestViewRef = useRef(null)
  const { activeUsers, updateLocation, sessionId } = usePresence({ page: 'registry', page_label: 'Реестр обязательств', mode: 'view' })

  useEffect(() => {
    Promise.all([request('/api/references'), request('/api/saved-view')]).then(([references, saved]) => {
      const view = normalizeSavedView(saved)
      setRefs(references); setFilters(view.filters); setPage(view.page); setSort(view.sort); setTableFullscreen(view.fullscreen)
      scrollPositionRef.current = { left: view.scroll_left, top: view.scroll_top }
    }).catch(error => notify(error.message, 'error')).finally(() => setViewReady(true))
  }, [])
  const query = useMemo(() => {
    const params = new URLSearchParams({ page, page_size: 50, sort: sort.key, order: sort.order })
    Object.entries(filters).forEach(([key, value]) => {
      if (Array.isArray(value)) value.filter(Boolean).forEach(item => params.append(key, item))
      else if (value) params.set(key, value)
    })
    return params.toString()
  }, [filters, page, sort])
  const load = () => { setLoading(true); request(`/api/obligations?${query}`).then(result => { const lastPage = Math.max(1, Math.ceil(result.total / result.page_size)); if (page > lastPage) { setPage(lastPage); return }; rowsRef.current = new Map(result.items.map(item => [item.id, item])); setData(result) }).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  useEffect(() => { if (!viewReady) return; const timer = setTimeout(load, 220); return () => clearTimeout(timer) }, [query, viewReady])
  const viewPayload = () => ({ filters, page, sort, scroll_left: scrollPositionRef.current.left, scroll_top: scrollPositionRef.current.top, fullscreen: tableFullscreen })
  latestViewRef.current = viewReady ? viewPayload() : null
  useEffect(() => {
    if (!viewReady) return
    const timer = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(viewPayload()) }).catch(() => {}), 300)
    return () => clearTimeout(timer)
  }, [filters, page, sort, tableFullscreen, viewReady])
  useEffect(() => {
    const flushView = () => {
      clearTimeout(scrollSaveTimerRef.current)
      if (latestViewRef.current) request('/api/saved-view', { method: 'PUT', body: JSON.stringify(latestViewRef.current), keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', flushView)
    return () => { window.removeEventListener('pagehide', flushView); flushView() }
  }, [])
  useEffect(() => {
    if (!viewReady || loading) return
    const frame = requestAnimationFrame(() => tableWrapRef.current?.scrollTo(scrollPositionRef.current))
    return () => cancelAnimationFrame(frame)
  }, [viewReady, loading, data.items.length])
  useEffect(() => {
    if (!tableFullscreen) return
    const exitFullscreen = event => { if (event.key === 'Escape' && !event.defaultPrevented) setTableFullscreen(false) }
    document.addEventListener('keydown', exitFullscreen)
    return () => document.removeEventListener('keydown', exitFullscreen)
  }, [tableFullscreen])
  useEffect(() => {
    try { window.localStorage.setItem(registryLargeFontKey, String(largeTableFont)) } catch {}
  }, [largeTableFont])
  const setFilter = (key, value) => { setFilters(old => ({ ...old, [key]: value })); setPage(1) }
  const rememberScroll = event => {
    scrollPositionRef.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
    if (latestViewRef.current) latestViewRef.current = { ...latestViewRef.current, scroll_left: scrollPositionRef.current.left, scroll_top: scrollPositionRef.current.top }
    clearTimeout(scrollSaveTimerRef.current)
    scrollSaveTimerRef.current = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(viewPayload()) }).catch(() => {}), 350)
  }
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const allSelected = data.items.length > 0 && data.items.every(item => selected.includes(item.id))
  const selectedItem = selected.length === 1 ? rowsRef.current.get(selected[0]) : null
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
    const next = withCalculatedPlannedDate({ ...current, [field]: value }, field)
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
        if (!sameCellValue(next.planned_payment_date, current.planned_payment_date) && sameCellValue(latest?.planned_payment_date, next.planned_payment_date)) reverted.planned_payment_date = current.planned_payment_date
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
    const next = withCalculatedPlannedDate({ ...item, [field]: value }, field)
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
  const splitPayment = async (item, values) => {
    try {
      const result = await request(`/api/obligations/${item.id}/split`, { method: 'POST', body: JSON.stringify(values) })
      notify(`Платёж разбит на ${result.installments.length} ${partWord(result.installments.length)} без изменения общей суммы`)
      setSplitItem(null); setSelected([]); load()
    } catch (error) { notify(error.message, 'error'); throw error }
  }
  const importFile = async event => { const file = event.target.files?.[0]; if (!file) return; const body = new FormData(); body.append('file', file); try { const result = await request('/api/obligations/import.xlsx', { method: 'POST', body }); notify(`База обновлена: ${result.updated} изменено, ${result.created} добавлено`); load(); request('/api/references').then(setRefs).catch(e => notify(e.message, 'error')) } catch (e) { notify(e.message, 'error') } finally { event.target.value = '' } }
  const doSort = key => setSort(current => ({ key, order: current.key === key && current.order === 'asc' ? 'desc' : 'asc' }))
  return <div className={`page registry-page ${tableFullscreen ? 'is-table-fullscreen' : ''}`}>
    <PageHeader eyebrow="Рабочая область" title="Реестр обязательств" subtitle={`${data.total.toLocaleString('ru-RU')} записей с учётом фильтров`} actions={<><PresenceCluster users={activeUsers} currentSession={sessionId}/>{user.role === 'admin' && <><input ref={importRef} type="file" accept=".xlsx" hidden onChange={importFile}/><button className="secondary" onClick={() => importRef.current.click()}><FileUp size={17}/>Импорт</button></>}<button className="secondary" onClick={() => download(`/api/obligations/export.xlsx?${query}`, 'Реестр обязательств.xlsx')}><Download size={17}/>Excel</button><FontSizeButton large={largeTableFont} onToggle={() => setLargeTableFont(value => !value)}/><button className="secondary registry-fullscreen-button" onClick={() => setTableFullscreen(true)} title="Открыть таблицу на весь экран" aria-label="Открыть таблицу на весь экран"><Maximize2 size={17}/></button></>}/>
    <section className="filter-panel">
      <div className="search-box"><Search size={18}/><input placeholder="Контрагент, счёт, комментарий…" value={filters.q} onChange={e => setFilter('q', e.target.value)}/>{filters.q && <button onClick={() => setFilter('q', '')}><X size={15}/></button>}</div>
      <label className="filter-date"><span>Срок с</span><DateInput value={filters.planned_from} onChange={value => setFilter('planned_from', value)} aria-label="Срок с"/></label>
      <label className="filter-date"><span>по</span><DateInput value={filters.planned_to} onChange={value => setFilter('planned_to', value)} aria-label="Срок по"/></label>
      <button className={`overdue-toggle ${filters.overdue ? 'active' : ''}`} onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}><Filter size={15}/>Только просроченные</button>
      {hasActiveFilters(filters) && <button className="reset-filters" onClick={() => { setFilters(emptyFilters); setPage(1) }}><RotateCcw size={15}/>Сбросить</button>}
    </section>
    <section className="table-card">
      {tableFullscreen && <div className="registry-fullscreen-controls"><FontSizeButton large={largeTableFont} onToggle={() => setLargeTableFont(value => !value)}/><button type="button" className="registry-fullscreen-exit" onClick={() => setTableFullscreen(false)} title="Вернуться к обычному виду" aria-label="Вернуться к обычному виду"><Minimize2 size={17}/><span>Обычный вид</span></button></div>}
      {selected.length > 0 && <div className="selection-bar"><span><Check size={16}/>{selected.length} выбрано</span>{user.role !== 'viewer' && selectedItem && canSplitPayment(selectedItem) && <button onClick={() => setSplitItem(selectedItem)}><Scissors size={15}/>Разбить платёж</button>}{user.role !== 'viewer' && <button onClick={() => setBulkOpen(true)}>Изменить статус и даты</button>}<button onClick={() => setSelected([])}>Снять выбор</button></div>}
      <div ref={tableWrapRef} className="registry-table-wrap" onScroll={rememberScroll}><table className={`registry-table inline-registry ${largeTableFont ? 'registry-font-large' : ''}`}><colgroup>{registryColumnWidths.map((width, index) => <col key={index} style={{ width }}/>)}</colgroup><thead><tr><th className="check-col">{user.role !== 'viewer' ? <button type="button" className={`inline-add-row ${newRow ? 'active' : ''}`} onClick={addInlineRow} title={newRow ? 'Убрать новую строку' : 'Добавить строку'} aria-label={newRow ? 'Убрать новую строку' : 'Добавить строку'}><Plus size={16}/></button> : <input type="checkbox" checked={allSelected} onChange={toggleAll}/>}</th>
        <ColumnHead className="counterparty-head" label="Контрагент" field="counterparty" sort={sort} onSort={doSort} value={filters.counterparty} options={refs.counterparties} onFilter={value => setFilter('counterparty', value)} multiple/>
        <ColumnHead className="entry-date-head" label="Дата внесения" field="entry_date" sort={sort} onSort={doSort} dateValue={filters.entry_date} onDateFilter={value => setFilter('entry_date', value)}/>
        <ColumnHead className="account-type-head" label="Признак" value={filters.account_type} options={refs.account_types} onFilter={value => setFilter('account_type', value)}/>
        <ColumnHead className="legal-entity-head" label="Юрлицо" field="legal_entity" sort={sort} onSort={doSort} value={filters.legal_entity} options={refs.legal_entities} onFilter={value => setFilter('legal_entity', value)}/>
        <ColumnHead label="Сумма" field="amount" sort={sort} onSort={doSort}/>
        <th>Документ</th><ColumnHead label="Дата документа" dateValue={filters.document_date} onDateFilter={value => setFilter('document_date', value)}/>
        <ColumnHead label="Статья затрат" value={filters.cost_category} options={refs.cost_categories} onFilter={value => setFilter('cost_category', value)}/>
        <th>Отсрочка, дней</th>
        <ColumnHead label="Плановая оплата" field="planned_payment_date" sort={sort} onSort={doSort} dateValue={filters.planned_payment_date} onDateFilter={value => setFilter('planned_payment_date', value)}/>
        <ColumnHead label="Дата утверждения" field="approval_date" sort={sort} onSort={doSort} dateValue={filters.approval_date} onDateFilter={value => setFilter('approval_date', value)}/>
        <ColumnHead label="Фактическая оплата" dateValue={filters.actual_payment_date} onDateFilter={value => setFilter('actual_payment_date', value)}/>
        <ColumnHead label="Статус" field="status" sort={sort} onSort={doSort} value={filters.status} options={refs.statuses} onFilter={value => setFilter('status', value)}/>
        <ColumnHead label="Срочность" value={filters.urgency} options={refs.urgencies} onFilter={value => setFilter('urgency', value)}/>
        <ColumnHead label="Ответственный" value={filters.responsible} options={refs.responsibles} onFilter={value => setFilter('responsible', value)}/>
        <ColumnHead label="Приоритет" value={filters.priority} options={refs.priorities} onFilter={value => setFilter('priority', value)}/>
        <th>Комментарий</th><th>Условия оплаты</th><th className="action-col"/></tr></thead>
      <tbody>{newRow && <RegistryRow item={newRow} refs={refs} editable isNew savingCells={savingCells} onCommit={commitNewCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onDelete={() => setNewRow(null)}/>} {loading ? <SkeletonRows/> : data.items.length === 0 && !newRow ? <tr><td colSpan="20"><div className="empty-state"><Search size={27}/><strong>Ничего не найдено</strong><span>Измените или сбросьте фильтры</span></div></td></tr> : data.items.map(item => <RegistryRow key={item.id} item={item} refs={refs} editable={user.role !== 'viewer'} selected={selected.includes(item.id)} savingCells={savingCells} onToggle={() => setSelected(s => s.includes(item.id) ? s.filter(id => id !== item.id) : [...s, item.id])} onCommit={commitCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onSplit={user.role !== 'viewer' && canSplitPayment(item) ? () => setSplitItem(item) : null} onDelete={user.role !== 'viewer' ? () => remove(item.id) : null}/>)}</tbody></table></div>
      <footer className="table-footer"><span>Показано {data.items.length} из {data.total.toLocaleString('ru-RU')}</span><div><button disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17}/></button><span>Страница <b>{page}</b> из {totalPages}</span><button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={17}/></button></div></footer>
    </section>
    {bulkOpen && (
      <BulkModal count={selected.length} refs={refs} onClose={() => setBulkOpen(false)} onSave={async values => { try { await request('/api/obligations/bulk', { method: 'POST', body: JSON.stringify({ ids: selected, ...values }) }); notify('Выбранные строки обновлены'); setBulkOpen(false); setSelected([]); load() } catch (e) { notify(e.message, 'error') } }}/>
    )}
    {splitItem && <SplitPaymentModal item={splitItem} refs={refs} onClose={() => setSplitItem(null)} onSave={values => splitPayment(splitItem, values)}/>}
  </div>
}

function FontSizeButton({ large, onToggle }) {
  return <button type="button" className={`secondary registry-font-button ${large ? 'active' : ''}`} onClick={onToggle} aria-pressed={large} aria-label={large ? 'Вернуть обычный размер шрифта в таблице' : 'Увеличить размер шрифта в таблице'} title={large ? 'Обычный шрифт' : 'Увеличить шрифт'}><span aria-hidden="true">A<sup>+</sup></span><b>{large ? 'Обычный' : 'Крупнее'}</b></button>
}

function ColumnHead({ label, field, sort, onSort, value = '', options, onFilter, dateValue = '', onDateFilter, className = '', multiple = false }) {
  const sorted = field && sort?.key === field
  const filtered = (Array.isArray(value) ? value.length > 0 : Boolean(value)) || Boolean(dateValue)
  return <th className={`${className} ${sorted ? 'sorted' : ''} ${filtered ? 'filtered' : ''}`}><div className="column-head-inner">
    {field ? <button type="button" className="column-sort" onClick={() => onSort(field)}>{label}<i>{sorted ? (sort.order === 'asc' ? '↑' : '↓') : '↕'}</i></button> : <span className="column-label">{label}</span>}
    {onFilter && <HeaderFilter label={label} value={value} options={options} onChange={onFilter} multiple={multiple}/>}
    {onDateFilter && <DateHeaderFilter label={label} value={dateValue} onChange={onDateFilter}/>}
  </div></th>
}

function DateHeaderFilter({ label, value, onChange }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  return <div className={`header-filter date-header-filter ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
    <button ref={triggerRef} type="button" className="header-filter-trigger" aria-label={`Фильтр по дате: ${label}`} aria-expanded={open} onClick={() => setOpen(current => !current)}><CalendarDays size={13}/>{value && <i/>}</button>
    {open && <DateInput value={value} onChange={next => { onChange(next); setOpen(false) }} onClose={() => setOpen(false)} closeOnScroll={false} anchorRef={triggerRef} triggerOnly aria-label={`Дата фильтра: ${label}`} autoFocus/>}
  </div>
}

function HeaderFilter({ label, value, options = [], onChange, multiple = false }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const values = useMemo(() => [...new Set(options.map(option => typeof option === 'string' ? option : option.value).filter(Boolean))], [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? values.filter(option => option.toLocaleLowerCase('ru-RU').includes(term)) : values }, [search, values])
  const selectedValues = multiple ? (Array.isArray(value) ? value : value ? [value] : []) : value ? [value] : []
  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])
  const select = next => {
    if (!multiple) { onChange(next); setSearch(''); setOpen(false); return }
    if (!next) { onChange([]); return }
    onChange(selectedValues.includes(next) ? selectedValues.filter(item => item !== next) : [...selectedValues, next])
  }
  return <div ref={rootRef} className={`header-filter ${open ? 'is-open' : ''} ${selectedValues.length ? 'has-value' : ''}`}>
    <button type="button" className="header-filter-trigger" aria-label={`Фильтр: ${label}${multiple && selectedValues.length ? `, выбрано ${selectedValues.length}` : ''}`} aria-expanded={open} onClick={() => { setSearch(''); setOpen(current => !current) }}><ChevronDown size={13}/>{selectedValues.length > 0 && <i/>}</button>
    {open && <div className="header-filter-menu">
      <div className="header-filter-search"><Search size={15}/><input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по наименованию" aria-label={`Поиск: ${label}`}/>{search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={13}/></button>}</div>
      <div className="header-filter-options" role="listbox" aria-multiselectable={multiple || undefined} aria-label={`Значения: ${label}`}>
        <button type="button" className={!selectedValues.length ? 'selected' : ''} onClick={() => select('')}><span>Все значения</span>{!selectedValues.length && <Check size={14}/>}</button>
        {visible.map(option => { const selected = selectedValues.includes(option); return <button type="button" key={option} className={selected ? 'selected' : ''} onClick={() => select(option)} title={option} role="option" aria-selected={selected}><span>{option}</span>{selected && <Check size={14}/>}</button> })}
        {!visible.length && <p>Ничего не найдено</p>}
      </div>
    </div>}
  </div>
}

function normalizeSavedFilters(saved) {
  const counterparty = Array.isArray(saved.counterparty) ? saved.counterparty.filter(Boolean) : saved.counterparty ? [saved.counterparty] : []
  return { ...emptyFilters, ...saved, counterparty }
}

function normalizeSavedView(saved) {
  const structured = saved && typeof saved.filters === 'object' && !Array.isArray(saved.filters)
  const filters = normalizeSavedFilters(structured ? saved.filters : (saved || {}))
  const savedPage = structured ? Number(saved.page) : 1
  const savedSort = structured && saved.sort && typeof saved.sort === 'object' ? saved.sort : {}
  const sortKeys = ['entry_date', 'counterparty', 'legal_entity', 'amount', 'planned_payment_date', 'approval_date', 'status', 'priority', 'updated_at']
  const sortKey = sortKeys.includes(savedSort.key) ? savedSort.key : 'updated_at'
  const order = savedSort.order === 'asc' ? 'asc' : 'desc'
  return {
    filters,
    page: Number.isInteger(savedPage) && savedPage > 0 ? savedPage : 1,
    sort: { key: sortKey, order },
    scroll_left: structured ? Math.max(0, Number(saved.scroll_left) || 0) : 0,
    scroll_top: structured ? Math.max(0, Number(saved.scroll_top) || 0) : 0,
    fullscreen: structured && saved.fullscreen === true,
  }
}

function hasActiveFilters(filters) {
  return Object.values(filters).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))
}

function RegistryRow({ item, refs, editable, isNew = false, selected, savingCells, onToggle, onCommit, onStartEdit, onFinishEdit, onSplit, onDelete }) {
  const saving = field => savingCells.has(`${isNew ? 'new' : item.id}:${field}`)
  const cell = (field, props = {}) => <EditableCell item={item} field={field} label={fieldLabels[field]} editable={editable} saving={saving(field)} onCommit={onCommit} onStartEdit={onStartEdit} onFinishEdit={onFinishEdit} {...props}/>
  return <tr className={`${isNew ? 'inline-new-row' : rowTone(item)}`}>
    <td className="check-col">{isNew ? <button type="button" className="cancel-inline-row" onClick={onDelete} title="Отменить новую строку"><X size={14}/></button> : <input type="checkbox" checked={selected} onChange={onToggle}/>}</td>
    {cell('counterparty', { className: 'counterparty-cell', options: refs.counterparties, allowCustom: true })}
    {cell('entry_date', { type: 'date', className: 'entry-date-cell' })}
    {cell('account_type', { options: refs.account_types, className: 'account-type-cell' })}
    {cell('legal_entity', { options: refs.legal_entities, className: 'legal-entity-cell' })}
    {cell('amount', { type: 'number', className: 'money-cell', render: value => value == null || value === '' ? '—' : <span className="installment-amount"><span>{money(value)}</span>{item.installment_count > 1 && <small>Платёж {item.installment_number} из {item.installment_count}</small>}</span> })}
    {cell('document_number')}
    {cell('document_date', { type: 'date' })}
    {cell('cost_category', { options: refs.cost_categories, className: 'category-cell' })}
    {cell('deferment_days', { type: 'number' })}
    {cell('planned_payment_date', { type: 'date', className: item.overdue ? 'date-overdue' : '' })}
    {cell('approval_date', { type: 'date' })}
    {cell('actual_payment_date', { type: 'date' })}
    {cell('status', { options: refs.statuses, render: value => <Status value={value}/> })}
    {cell('urgency', { options: refs.urgencies, render: value => <Urgency value={value}/> })}
    {cell('responsible', { options: refs.responsibles })}
    {cell('priority', { options: refs.priorities })}
    {cell('comment', { className: 'comment-cell' })}
    {cell('source_note', { className: 'comment-cell' })}
    <td className="action-col">{!isNew && (onSplit || onDelete) && <div className="row-actions">{onSplit && <button className="split-button" onClick={onSplit} title="Разбить платёж"><Scissors size={16}/></button>}{onDelete && <button className="danger-button" onClick={onDelete} title="Удалить"><Trash2 size={16}/></button>}</div>}</td>
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
  const ariaValue = cellAriaValue(field, item[field])
  return <td className={`editable-cell ${className} ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`} aria-label={`${label}: ${ariaValue}`} onClick={begin} title={!editing ? `${label}: ${ariaValue}${editable ? '\nНажмите, чтобы изменить' : ''}` : undefined}>
    {editing ? options ? <InlineCellSelect label={label} value={item[field] || ''} options={options} allowCustom={allowCustom} onChoose={value => { setDraft(value); onCommit(item, field, value).then(ok => ok && setEditing(false)) }} onCancel={cancel}/> : type === 'date' ? <DateInput className="inline-cell-input" value={item[field] || ''} onChange={value => onCommit(item, field, value).then(ok => ok && setEditing(false))} onClose={() => { setEditing(false); onFinishEdit(item) }} aria-label={label} autoFocus/> : <input className="inline-cell-input" type={type === 'number' ? 'number' : 'text'} placeholder="Введите значение" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} autoFocus/> : <div className="cell-display"><div className="cell-display-value">{display}</div></div>}
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
function strip(values) {
  const result = { ...values }
  for (const field of ['id', 'created_at', 'updated_at', 'overdue', 'due_soon', 'split_group_id', 'split_parent_id', 'installment_number', 'installment_count']) delete result[field]
  return result
}
function blankObligation() { return { account_type:'',entry_date:todayISO(),counterparty:'',legal_entity:'',cost_category:'',priority:'',responsible:'',document_number:'',deferment_days:null,document_date:'',amount:null,planned_payment_date:'',approval_date:'',actual_payment_date:'',status:'Зарегистрирован',urgency:'',comment:'',source_note:'' } }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function sameCellValue(left, right) { return (left ?? '') === (right ?? '') }
function withCalculatedPlannedDate(values, changedField) {
  if (changedField !== 'deferment_days' && changedField !== 'document_date') return values
  if (!values.document_date || values.deferment_days == null || values.deferment_days === '') return values
  const date = new Date(`${values.document_date}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return values
  date.setUTCDate(date.getUTCDate() + Number(values.deferment_days))
  return { ...values, planned_payment_date: date.toISOString().slice(0, 10) }
}
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

function SplitPaymentModal({ item, refs, onClose, onSave }) {
  const defaultDate = item.planned_payment_date || todayISO()
  const accountTypes = refs.account_types || []
  const [form, setForm] = useState({ mode: 'count', count: 3, payment_amount: '', start_date: defaultDate, period_unit: 'month', period_value: 1, percentage_parts: [{ percent: '', account_type: '', planned_date: '' }, { percent: '', account_type: '', planned_date: '' }] })
  const [saving, setSaving] = useState(false)
  const preview = useMemo(() => buildSplitPreview(Number(item.amount), form), [item.amount, form])
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const updatePercentagePart = (index, key, value) => setForm(current => ({ ...current, percentage_parts: current.percentage_parts.map((part, partIndex) => partIndex === index ? { ...part, [key]: value } : part) }))
  const addPercentagePart = () => setForm(current => {
    if (current.percentage_parts.length >= 60) return current
    return { ...current, percentage_parts: [...current.percentage_parts, { percent: '', account_type: '', planned_date: '' }] }
  })
  const removePercentagePart = index => setForm(current => current.percentage_parts.length <= 2 ? current : { ...current, percentage_parts: current.percentage_parts.filter((_, partIndex) => partIndex !== index) })
  const submit = async () => {
    if (preview.error || saving) return
    setSaving(true)
    try {
      await onSave({ ...form, count: Number(form.count), payment_amount: form.mode === 'amount' ? Number(form.payment_amount) : null, period_value: Number(form.period_value), percentage_parts: form.mode === 'percentage' ? form.percentage_parts.map(part => ({ ...part, percent: Number(part.percent) })) : null })
    } finally { setSaving(false) }
  }
  return <div className="modal-backdrop"><div className="modal split-payment-modal">
    <div className="modal-head"><div><p className="eyebrow">График оплаты</p><h2>Разбить платёж</h2></div><button onClick={onClose} aria-label="Закрыть"><X/></button></div>
    <div className="modal-body split-payment-body">
      <div className="split-source-card"><div><span>Контрагент</span><strong>{item.counterparty || 'Не указан'}</strong><small>{item.document_number ? `Документ ${item.document_number}` : 'Без номера документа'}</small></div><div><span>Общая сумма</span><strong>{money(item.amount)}</strong><small>Сумма графика останется неизменной</small></div></div>
      <div className="split-mode-tabs" role="tablist"><button type="button" className={form.mode === 'count' ? 'active' : ''} onClick={() => update('mode', 'count')}>Равными частями</button><button type="button" className={form.mode === 'amount' ? 'active' : ''} onClick={() => update('mode', 'amount')}>Заданная сумма</button><button type="button" className={form.mode === 'percentage' ? 'active' : ''} onClick={() => update('mode', 'percentage')}>По процентам</button></div>
      {form.mode === 'percentage' ? <div className="split-percentage-editor">
        <div className="split-percentage-head"><div><strong>Распределение платежа</strong><span>Для каждой доли укажите процент, признак учёта и дату</span></div><b className={preview.percentageTotal === 100 ? 'valid' : ''}>{formatPercent(preview.percentageTotal)} из 100%</b></div>
        <div className="split-percentage-list">{form.percentage_parts.map((part, index) => <div className="split-percentage-row" key={index}>
          <span className="split-percentage-number">{index + 1}</span>
          <label className="field"><span>Доля, %</span><input type="number" min="0.01" max="100" step="0.01" value={part.percent} onChange={event => updatePercentagePart(index, 'percent', event.target.value)}/></label>
          <label className="field"><span>Признак учёта</span><select value={part.account_type} onChange={event => updatePercentagePart(index, 'account_type', event.target.value)}><option value="">Выберите</option>{accountTypes.map(option => <option key={option.id ?? option.value} value={option.value}>{option.value}</option>)}</select></label>
          <label className="field"><span>Плановая дата</span><DateInput value={part.planned_date} onChange={value => updatePercentagePart(index, 'planned_date', value)} aria-label={`Плановая дата доли ${index + 1}`}/></label>
          <div className="split-percentage-amount"><span>Сумма доли</span><strong>{preview.items[index] ? money(preview.items[index].amount) : '—'}</strong></div>
          <button type="button" className="split-percentage-remove" onClick={() => removePercentagePart(index)} disabled={form.percentage_parts.length <= 2} aria-label={`Удалить долю ${index + 1}`} title="Удалить долю"><Trash2 size={16}/></button>
        </div>)}</div>
        <button type="button" className="split-percentage-add" onClick={addPercentagePart} disabled={form.percentage_parts.length >= 60}><Plus size={16}/>Добавить долю</button>
      </div> : <div className="split-settings-grid">
        {form.mode === 'count' ? <label className="field"><span>Количество платежей</span><input type="number" min="2" max="60" value={form.count} onChange={event => update('count', event.target.value)}/></label> : <label className="field"><span>Сумма одного платежа, ₽</span><input type="number" min="0.01" step="0.01" value={form.payment_amount} onChange={event => update('payment_amount', event.target.value)} placeholder="Например, 50 000"/></label>}
        <label className="field"><span>Дата первого платежа</span><DateInput value={form.start_date} onChange={value => update('start_date', value)} aria-label="Дата первого платежа"/></label>
        <label className="field"><span>Повторять каждые</span><input type="number" min="1" max="365" value={form.period_value} onChange={event => update('period_value', event.target.value)}/></label>
        <label className="field"><span>Период</span><select value={form.period_unit} onChange={event => update('period_unit', event.target.value)}><option value="month">Месяц</option><option value="week">Неделя</option><option value="day">День</option></select></label>
      </div>}
      {preview.error ? <div className="split-error">{preview.error}</div> : <div className="split-preview">
        <div className="split-preview-head"><div><strong>Предварительный график</strong><span>{preview.items.length} {paymentWord(preview.items.length)}</span></div><div><span>Итого</span><strong>{money(preview.total)}</strong></div></div>
        <div className="split-preview-scroll"><table><thead><tr><th>№</th>{form.mode === 'percentage' && <><th>Доля</th><th>Признак учёта</th></>}<th>Плановая дата</th><th>Сумма</th></tr></thead><tbody>{preview.items.map(part => <tr key={part.number}><td>{part.number}</td>{form.mode === 'percentage' && <><td>{formatPercent(part.percent)}</td><td>{part.account_type}</td></>}<td>{shortDate(part.date)}</td><td>{money(part.amount)}</td></tr>)}</tbody></table></div>
        {preview.hasRemainder && <p>Последний платёж скорректирован на остаток, поэтому общая сумма совпадает до копейки.</p>}
      </div>}
    </div>
    <div className="modal-footer"><button className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button className="primary" onClick={submit} disabled={Boolean(preview.error) || saving}>{saving ? 'Создаём график…' : `Разбить на ${preview.items.length || 0} платежа`}</button></div>
  </div></div>
}

function canSplitPayment(item) {
  return Number(item?.amount) > 0 && Number(item?.installment_count || 0) <= 1 && !item?.split_group_id && !item?.actual_payment_date && !['Оплачено', 'Отменено'].includes(item?.status)
}

function buildSplitPreview(amount, form) {
  const totalCents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(totalCents) || totalCents <= 0) return { error: 'У платежа должна быть положительная сумма.', items: [], total: 0 }
  if (form.mode === 'percentage') {
    const parts = form.percentage_parts || []
    if (parts.length < 2 || parts.length > 60) return { error: 'Количество долей должно быть от 2 до 60.', items: [], total: 0, percentageTotal: 0 }
    const prepared = []
    let totalPoints = 0
    for (let index = 0; index < parts.length; index++) {
      const raw = Number(parts[index].percent)
      const points = Math.round(raw * 100)
      if (!Number.isFinite(raw) || raw <= 0 || raw > 100 || Math.abs(raw * 100 - points) > 0.000001) return { error: `Укажите корректный процент для доли ${index + 1} с точностью до двух знаков.`, items: [], total: 0, percentageTotal: totalPoints / 100 }
      if (!parts[index].account_type) return { error: `Выберите признак учёта для доли ${index + 1}.`, items: [], total: 0, percentageTotal: (totalPoints + points) / 100 }
      if (!parts[index].planned_date || !/^\d{4}-\d{2}-\d{2}$/.test(parts[index].planned_date)) return { error: `Выберите плановую дату для доли ${index + 1}.`, items: [], total: 0, percentageTotal: (totalPoints + points) / 100 }
      prepared.push({ ...parts[index], points, index })
      totalPoints += points
    }
    if (totalPoints !== 10000) return { error: `Сумма долей должна быть ровно 100%, сейчас ${formatPercent(totalPoints / 100)}.`, items: [], total: 0, percentageTotal: totalPoints / 100 }
    const denominator = 10000n
    const total = BigInt(totalCents)
    const allocated = prepared.map(part => { const product = total * BigInt(part.points); return { ...part, cents: product / denominator, remainder: product % denominator } })
    let leftover = total - allocated.reduce((sum, part) => sum + part.cents, 0n)
    const byRemainder = [...allocated].sort((left, right) => Number(right.remainder - left.remainder) || left.index - right.index)
    for (let index = 0; leftover > 0n; index++, leftover--) byRemainder[index % byRemainder.length].cents++
    const centsByIndex = new Map(byRemainder.map(part => [part.index, part.cents]))
    const items = prepared.map((part, index) => ({ number: index + 1, date: part.planned_date, amount: Number(centsByIndex.get(index)) / 100, percent: part.points / 100, account_type: part.account_type }))
    if (items.some(part => part.amount < 0.01)) return { error: 'Одна из долей получается меньше одной копейки.', items: [], total: 0, percentageTotal: 100 }
    return { items, total: items.reduce((sum, part) => sum + part.amount, 0), hasRemainder: allocated.some(part => part.remainder !== 0n), error: '', percentageTotal: 100 }
  }
  const interval = Number(form.period_value)
  if (!form.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(form.start_date)) return { error: 'Выберите дату первого платежа.', items: [], total: 0 }
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return { error: 'Период должен быть целым числом от 1 до 365.', items: [], total: 0 }
  let amounts = []
  if (form.mode === 'count') {
    const count = Number(form.count)
    if (!Number.isInteger(count) || count < 2 || count > 60) return { error: 'Количество платежей должно быть от 2 до 60.', items: [], total: 0 }
    const base = Math.floor(totalCents / count)
    if (base < 1) return { error: 'Сумма слишком мала для выбранного количества платежей.', items: [], total: 0 }
    amounts = Array.from({ length: count }, (_, index) => index === count - 1 ? totalCents - base * (count - 1) : base)
  } else {
    const paymentCents = Math.round(Number(form.payment_amount) * 100)
    if (!Number.isFinite(paymentCents) || paymentCents < 1 || paymentCents >= totalCents) return { error: 'Сумма части должна быть больше нуля и меньше общей суммы.', items: [], total: 0 }
    const count = Math.ceil(totalCents / paymentCents)
    if (count > 60) return { error: 'Получается больше 60 платежей — увеличьте сумму части.', items: [], total: 0 }
    let remainder = totalCents
    while (remainder > 0) { const part = Math.min(paymentCents, remainder); amounts.push(part); remainder -= part }
  }
  const items = amounts.map((cents, index) => ({ number: index + 1, date: splitDate(form.start_date, index, form.period_unit, interval), amount: cents / 100 }))
  return { items, total: amounts.reduce((sum, cents) => sum + cents, 0) / 100, hasRemainder: amounts.length > 1 && amounts.at(-1) !== amounts[0], error: '' }
}

function formatPercent(value) { return `${Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%` }

function splitDate(startValue, index, unit, interval) {
  const [year, month, day] = startValue.split('-').map(Number)
  const step = index * interval
  if (unit === 'month') {
    const monthStart = new Date(Date.UTC(year, month - 1 + step, 1))
    const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate()
    return isoDate(new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, lastDay))))
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + step * (unit === 'week' ? 7 : 1))
  return isoDate(date)
}

function isoDate(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}` }
function paymentWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'платежей' : last === 1 ? 'платёж' : last >= 2 && last <= 4 ? 'платежа' : 'платежей' }
function partWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'частей' : last === 1 ? 'часть' : last >= 2 && last <= 4 ? 'части' : 'частей' }
function BulkModal({ count, refs, onClose, onSave }) { const [form,setForm]=useState({status:'',approval_date:'',actual_payment_date:''});return <div className="modal-backdrop"><div className="modal small-modal"><div className="modal-head"><div><p className="eyebrow">Массовое действие</p><h2>Изменить {count} строк</h2></div><button onClick={onClose}><X/></button></div><div className="modal-body stacked-fields"><SelectField label="Новый статус" value={form.status} options={refs.statuses} onChange={v=>setForm({...form,status:v})}/><Field label="Дата утверждения" type="date" value={form.approval_date} onChange={v=>setForm({...form,approval_date:v})}/><Field label="Фактическая дата оплаты" type="date" value={form.actual_payment_date} onChange={v=>setForm({...form,actual_payment_date:v})}/></div><div className="modal-footer"><button className="secondary" onClick={onClose}>Отмена</button><button className="primary" onClick={()=>onSave(form)}>Применить</button></div></div></div> }

