import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, Check, ChevronDown, CircleDollarSign, Gauge, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import { request } from './api'
import { money, PageHeader, shortDate } from './App'
import './priorityCenter.css'

const blankValue = '__blank__'
const emptyData = { summary: {}, matrix: [], items: [], options: {} }
const initialFilters = { scope: 'active', q: '', urgency: '', priority: '', legal_entity: '', responsible: '', status: '' }

export default function PriorityCenter({ notify }) {
  const [filters, setFilters] = useState(initialFilters)
  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const query = useMemo(() => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
    return params.toString()
  }, [filters])
  const load = () => {
    setLoading(true)
    return request(`/api/reports/priority-center?${query}`).then(setData).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(() => { const timer = window.setTimeout(load, 180); return () => window.clearTimeout(timer) }, [query])
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const selectMatrix = item => setFilters(current => ({ ...current, urgency: item.urgency === '—' ? blankValue : item.urgency, priority: item.priority === '—' ? blankValue : item.priority }))
  const activeCount = Object.entries(filters).filter(([key, value]) => key !== 'scope' && value).length
  return <div className="page priority-center-page">
    <PageHeader eyebrow="Реестр · управленческий фокус" title="Срочность и важность" subtitle="Единая очередь обязательств: сначала риски, затем ближайшие платежи" actions={<button className="secondary" onClick={load} disabled={loading}><RefreshCw size={17}/>Обновить</button>}/>
    <section className="priority-scope" aria-label="Период анализа">
      {[['active','Активные'],['overdue','Просроченные'],['week','Ближайшие 7 дней'],['all','Все записи']].map(([value,label]) => <button type="button" key={value} className={filters.scope === value ? 'active' : ''} onClick={() => update('scope', value)}>{label}</button>)}
    </section>
    <section className="priority-filter-panel panel">
      <label className="priority-search"><Search size={17}/><input value={filters.q} onChange={event => update('q', event.target.value)} placeholder="Контрагент, документ, комментарий…"/>{filters.q && <button type="button" onClick={() => update('q','')} aria-label="Очистить поиск"><X size={14}/></button>}</label>
      <PrioritySelect label="Срочность" value={filters.urgency} options={data.options.urgencies} allowBlank onChange={value => update('urgency', value)}/>
      <PrioritySelect label="Важность" value={filters.priority} options={data.options.priorities} allowBlank onChange={value => update('priority', value)}/>
      <PrioritySelect label="Юридическое лицо" value={filters.legal_entity} options={data.options.legal_entities} onChange={value => update('legal_entity', value)}/>
      <PrioritySelect label="Ответственный" value={filters.responsible} options={data.options.responsibles} onChange={value => update('responsible', value)}/>
      <PrioritySelect label="Статус" value={filters.status} options={data.options.statuses} onChange={value => update('status', value)}/>
      <button type="button" className="priority-reset" onClick={() => setFilters(initialFilters)} disabled={!activeCount}><SlidersHorizontal size={16}/><span>Сбросить</span>{activeCount > 0 && <b>{activeCount}</b>}</button>
    </section>
    <PrioritySummary summary={data.summary}/>
    <section className="priority-layout">
      <article className="panel priority-matrix">
        <header><div><p className="eyebrow">Матрица решений</p><h2>Где требуется внимание</h2></div><span>Нажмите карточку, чтобы применить пару фильтров</span></header>
        {loading ? <div className="priority-loading"/> : data.matrix.length === 0 ? <EmptyState/> : <div className="priority-matrix-grid">{data.matrix.map(item => <button type="button" key={`${item.urgency}-${item.priority}`} className={`priority-cell ${item.overdue_count ? 'has-overdue' : ''}`} onClick={() => selectMatrix(item)}>
          <span><i className={toneClass(item.urgency)}/>{item.urgency}<em>{item.priority}</em></span><strong>{money(item.amount)}</strong><small>{item.count} обязательств{item.overdue_count ? ` · ${item.overdue_count} просрочено` : ''}</small><time>{item.earliest_due ? `Ближайшая дата ${shortDate(item.earliest_due)}` : 'Дата не указана'}</time>
        </button>)}</div>}
      </article>
      <article className="panel priority-guide"><Gauge size={24}/><h2>Как читать очередь</h2><p>Карточки с красной отметкой содержат просроченные обязательства. Внутри каждой группы записи отсортированы по плановой дате оплаты.</p><ul><li><b>Срочность</b> — когда требуется действие.</li><li><b>Важность</b> — влияние платежа на работу.</li><li><b>Без классификации</b> — записи, которые нужно разобрать.</li></ul></article>
    </section>
    <section className="panel priority-table-card">
      <header><div><p className="eyebrow">Детализация</p><h2>Очередь обязательств</h2></div><span>Показано {data.items.length}{data.items.length === 300 ? ' · примените фильтры для точного отбора' : ''}</span></header>
      <div className="priority-table-wrap"><table><thead><tr><th>Срочность</th><th>Важность</th><th>Плановая дата</th><th>Контрагент / документ</th><th>Юридическое лицо</th><th>Статья затрат</th><th>Ответственный</th><th>Статус</th><th>Сумма</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id} className={item.overdue ? 'is-overdue' : ''}><td><PriorityBadge value={item.urgency}/></td><td><PriorityBadge value={item.priority} quiet/></td><td><strong>{shortDate(item.planned_payment_date)}</strong>{item.overdue && <small>Просрочено</small>}</td><td><strong>{item.counterparty || '—'}</strong><small>{item.document_number || 'Без номера'}{item.document_date ? ` от ${shortDate(item.document_date)}` : ''}</small></td><td>{item.legal_entity || '—'}</td><td>{item.cost_category || '—'}</td><td>{item.responsible || '—'}</td><td><span className="priority-status">{item.status || '—'}</span></td><td className="priority-amount">{money(item.amount)}</td></tr>)}</tbody></table></div>
      {!loading && data.items.length === 0 && <EmptyState/>}
    </section>
  </div>
}

function PrioritySummary({ summary = {} }) {
  const items = [
    [CircleDollarSign,'В выбранном фокусе',summary.count,summary.amount,'mint'],
    [AlertTriangle,'Просрочено',summary.overdue_count,summary.overdue_amount,'danger'],
    [CalendarClock,'Ближайшие 7 дней',summary.week_count,summary.week_amount,'warning'],
    [SlidersHorizontal,'Без классификации',summary.unclassified_count,summary.unclassified_amount,'neutral'],
  ]
  return <section className="priority-summary">{items.map(([Icon,label,count,amount,tone]) => <article key={label} className={`priority-kpi ${tone}`}><i><Icon size={20}/></i><div><span>{label}</span><strong>{money(amount)}</strong><small>{count || 0} обязательств</small></div></article>)}</section>
}

function PrioritySelect({ label, value, options = [], allowBlank = false, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    const close = event => { if (!ref.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const values = useMemo(() => [...new Set((options || []).filter(Boolean))].filter(item => item.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))), [options, search])
  const labelValue = value === blankValue ? 'Не выбрано (—)' : value || 'Все'
  return <div className={`priority-select ${value ? 'has-value' : ''}`} ref={ref}>
    <span>{label}</span><button type="button" onClick={() => { setOpen(current => !current); setSearch('') }} aria-expanded={open}><b>{labelValue}</b><ChevronDown size={14}/></button>
    {open && <div className="priority-select-menu">{(options.length > 7 || search) && <label><Search size={14}/><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти…"/></label>}<button type="button" className={!value ? 'selected' : ''} onClick={() => { onChange(''); setOpen(false) }}>{!value && <Check size={13}/>}Все</button>{allowBlank && <button type="button" className={value === blankValue ? 'selected' : ''} onClick={() => { onChange(blankValue); setOpen(false) }}>{value === blankValue && <Check size={13}/>}Не выбрано (—)</button>}{values.map(item => <button type="button" key={item} className={value === item ? 'selected' : ''} onClick={() => { onChange(item); setOpen(false) }}>{value === item && <Check size={13}/>}<span>{item}</span></button>)}</div>}
  </div>
}

function PriorityBadge({ value, quiet = false }) { return <span className={`priority-badge ${quiet ? 'quiet' : ''}`}><i className={toneClass(value)}/>{value || 'Не выбрано'}</span> }
function toneClass(value = '') { const normalized = value.toLocaleLowerCase('ru'); return normalized.includes('крит') || normalized.includes('высок') || normalized.includes('сроч') ? 'red' : normalized.includes('сред') || normalized.includes('важ') ? 'amber' : normalized ? 'green' : 'gray' }
function EmptyState() { return <div className="priority-empty"><Gauge size={28}/><strong>По выбранным условиям записей нет</strong><span>Измените фильтры или выберите другой период.</span></div> }
