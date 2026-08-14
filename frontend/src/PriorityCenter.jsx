import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarCheck2, CalendarClock, Check, CheckCircle2, ChevronDown, CircleDollarSign, Clock3, RefreshCw, Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { can, canApproveObligations } from './permissions'
import './priorityCenter.css'

const blankValue = '__blank__'
const emptyData = { summary: {}, items: [], options: {} }
const initialFilters = { scope: 'urgent', status: 'registered', q: '', urgency: '', priority: '', legal_entity: '', responsible: '' }
const todayISO = () => new Date().toLocaleDateString('en-CA')

export default function PriorityCenter({ user, notify }) {
  const [filters, setFilters] = useState(initialFilters)
  const [data, setData] = useState(emptyData)
  const [selected, setSelected] = useState([])
  const [approvalDate, setApprovalDate] = useState(todayISO)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const approvalAllowed = can(user, 'priority_center.approve') && canApproveObligations(user)
  const query = useMemo(() => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
    return params.toString()
  }, [filters])
  const load = () => {
    setLoading(true)
    return request(`/api/reports/priority-center?${query}`).then(result => {
      setData(result)
      setSelected(current => current.filter(id => result.items.some(item => item.id === id && isRegistered(item.status))))
    }).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(() => { const timer = window.setTimeout(load, 160); return () => window.clearTimeout(timer) }, [query])
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const approvable = data.items.filter(item => isRegistered(item.status))
  const allSelected = approvable.length > 0 && approvable.every(item => selected.includes(item.id))
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const approve = async ids => {
    if (!approvalAllowed || saving || ids.length === 0) return
    setSaving(true)
    try {
      const result = await request('/api/reports/priority-center/approve', { method: 'POST', body: JSON.stringify({ ids, approval_date: approvalDate }) })
      notify(`${result.updated} платежей согласовано · статус «К оплате»`)
      setSelected([])
      await load()
    } catch (error) { notify(error.message, 'error') } finally { setSaving(false) }
  }
  const activeCount = Object.entries(filters).filter(([key, value]) => !['scope', 'status'].includes(key) && value).length
  return <div className="page priority-center-page">
    <PageHeader eyebrow="Реестр · рабочее место руководителя" title="Срочные платежи" subtitle="Сначала просроченные и ближайшие обязательства — согласование в один клик" actions={<button className="secondary" onClick={load} disabled={loading || saving}><RefreshCw size={17}/>Обновить</button>}/>

    <section className="urgent-scope" aria-label="Период срочности">
      {[['urgent','Требуют внимания'],['overdue','Просрочены'],['today','Сегодня и просрочено'],['week','Ближайшие 7 дней'],['all','Все активные']].map(([value,label]) => <button type="button" key={value} className={filters.scope === value ? 'active' : ''} onClick={() => update('scope', value)}>{label}</button>)}
    </section>

    <section className="urgent-filter-panel panel">
      <label className="urgent-search"><Search size={17}/><input value={filters.q} onChange={event => update('q', event.target.value)} placeholder="Контрагент, документ, комментарий…"/>{filters.q && <button type="button" onClick={() => update('q','')} aria-label="Очистить поиск"><X size={14}/></button>}</label>
      <PrioritySelect label="Статус" value={filters.status} options={[['registered','Зарегистрировано'],['payable','К оплате'],['all','Все активные']]} onChange={value => update('status', value)}/>
      <PrioritySelect label="Срочность" value={filters.urgency} options={data.options.urgencies} allowBlank onChange={value => update('urgency', value)}/>
      <PrioritySelect label="Важность" value={filters.priority} options={data.options.priorities} allowBlank onChange={value => update('priority', value)}/>
      <PrioritySelect label="Юридическое лицо" value={filters.legal_entity} options={data.options.legal_entities} onChange={value => update('legal_entity', value)}/>
      <PrioritySelect label="Ответственный" value={filters.responsible} options={data.options.responsibles} onChange={value => update('responsible', value)}/>
      <button type="button" className="urgent-reset" onClick={() => setFilters(initialFilters)} disabled={!activeCount}><SlidersHorizontal size={16}/><span>Сбросить</span>{activeCount > 0 && <b>{activeCount}</b>}</button>
    </section>

    <UrgentSummary summary={data.summary}/>

    {approvalAllowed ? <section className="approval-dock panel">
      <div className="approval-dock-title"><ShieldCheck size={22}/><span><strong>Быстрое согласование</strong><small>Изменяются только статус и дата утверждения</small></span></div>
      <label><span>Дата утверждения</span><DateInput value={approvalDate} onChange={setApprovalDate} aria-label="Дата утверждения срочных платежей"/></label>
      <div className="approval-dock-selection"><strong>{selected.length}</strong><span>выбрано</span></div>
      <button type="button" className="approve-selected" disabled={!selected.length || saving} onClick={() => approve(selected)}><CheckCircle2 size={18}/>{saving ? 'Сохраняем…' : 'Выбранные — к оплате'}</button>
    </section> : <section className="approval-readonly-note"><ShieldCheck size={18}/><span>Для согласования включите руководителю права «Установка статуса “К оплате”» и «Быстрое согласование платежей».</span></section>}

    <section className="panel urgent-table-card">
      <header><div><p className="eyebrow">Очередь на решение</p><h2>Платежи по степени срочности</h2></div><span>Показано {data.items.length}{data.items.length === 300 ? ' · уточните фильтры' : ''}</span></header>
      <div className="urgent-table-wrap"><table><thead><tr><th className="urgent-check">{approvalAllowed && <input type="checkbox" aria-label="Выбрать все доступные платежи" checked={allSelected} onChange={() => setSelected(allSelected ? [] : approvable.map(item => item.id))}/>}</th><th>Срок</th><th>Срочность / важность</th><th>Контрагент и документ</th><th>Юридическое лицо</th><th>Статья затрат</th><th>Ответственный</th><th>Сумма</th><th>Решение</th></tr></thead>
      <tbody>{data.items.map(item => { const registered = isRegistered(item.status); return <tr key={item.id} className={`${item.overdue ? 'is-overdue' : item.due_today ? 'is-today' : ''} ${selected.includes(item.id) ? 'is-selected' : ''}`}>
        <td className="urgent-check">{approvalAllowed && registered && <input type="checkbox" aria-label={`Выбрать платёж №${item.id}`} checked={selected.includes(item.id)} onChange={() => toggle(item.id)}/>}</td>
        <td className="urgent-date"><strong>{shortDate(item.planned_payment_date)}</strong><small>{item.overdue ? 'Просрочено' : item.due_today ? 'Оплатить сегодня' : dueLabel(item.planned_payment_date)}</small></td>
        <td><div className="urgent-tags"><PriorityBadge value={item.urgency}/><PriorityBadge value={item.priority} quiet/></div></td>
        <td className="urgent-party"><strong>{item.counterparty || '—'}</strong><small>{item.document_number || 'Без номера'}{item.document_date ? ` от ${shortDate(item.document_date)}` : ''}</small>{item.comment && <em title={item.comment}>{item.comment}</em>}</td>
        <td>{item.legal_entity || '—'}</td><td>{item.cost_category || '—'}</td><td>{item.responsible || '—'}</td><td className="urgent-amount">{money(item.amount)}</td>
        <td className="urgent-decision">{approvalAllowed && registered ? <button type="button" disabled={saving} onClick={() => approve([item.id])}><Check size={15}/>К оплате</button> : <span className={registered ? 'registered' : 'payable'}>{item.status || '—'}{item.approval_date && <small>от {shortDate(item.approval_date)}</small>}</span>}</td>
      </tr>})}</tbody></table></div>
      {loading && <div className="urgent-loading"/>}
      {!loading && data.items.length === 0 && <div className="urgent-empty"><CalendarCheck2 size={30}/><strong>По выбранным условиям срочных платежей нет</strong><span>Измените период или фильтры.</span></div>}
    </section>
  </div>
}

function UrgentSummary({ summary = {} }) {
  const items = [
    [CircleDollarSign,'К согласованию',summary.count,summary.amount,'mint'],
    [AlertTriangle,'Просрочено',summary.overdue_count,summary.overdue_amount,'danger'],
    [Clock3,'На сегодня',summary.today_count,summary.today_amount,'warning'],
    [CalendarClock,'Ближайшие 7 дней',summary.week_count,summary.week_amount,'neutral'],
  ]
  return <section className="urgent-summary">{items.map(([Icon,label,count,amount,tone]) => <article key={label} className={`urgent-kpi ${tone}`}><i><Icon size={20}/></i><div><span>{label}</span><strong>{money(amount)}</strong><small>{count || 0} платежей</small></div></article>)}</section>
}

function PrioritySelect({ label, value, options = [], allowBlank = false, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  useEffect(() => { const close = event => { if (!ref.current?.contains(event.target)) setOpen(false) }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close) }, [])
  const normalized = useMemo(() => (options || []).map(item => Array.isArray(item) ? { value: item[0], label: item[1] } : { value: item, label: item }), [options])
  const values = normalized.filter(item => item.label.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
  const selectedLabel = value === blankValue ? 'Не выбрано (—)' : normalized.find(item => item.value === value)?.label || value || 'Все'
  return <div className={`urgent-select ${value ? 'has-value' : ''}`} ref={ref}><span>{label}</span><button type="button" onClick={() => { setOpen(current => !current); setSearch('') }} aria-expanded={open}><b>{selectedLabel}</b><ChevronDown size={14}/></button>{open && <div className="urgent-select-menu">{(normalized.length > 7 || search) && <label><Search size={14}/><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти…"/></label>}{!normalized.some(item => item.value === '') && <button type="button" className={!value ? 'selected' : ''} onClick={() => { onChange(''); setOpen(false) }}>{!value && <Check size={13}/>}Все</button>}{allowBlank && <button type="button" className={value === blankValue ? 'selected' : ''} onClick={() => { onChange(blankValue); setOpen(false) }}>{value === blankValue && <Check size={13}/>}Не выбрано (—)</button>}{values.map(item => <button type="button" key={item.value} className={value === item.value ? 'selected' : ''} onClick={() => { onChange(item.value); setOpen(false) }}>{value === item.value && <Check size={13}/>}<span>{item.label}</span></button>)}</div>}</div>
}

function PriorityBadge({ value, quiet = false }) { return <span className={`urgent-badge ${quiet ? 'quiet' : ''}`}><i className={toneClass(value)}/>{value || 'Не выбрано'}</span> }
function toneClass(value = '') { const normalized = value.toLocaleLowerCase('ru'); return normalized.includes('крит') || normalized.includes('высок') || normalized.includes('сроч') ? 'red' : normalized.includes('сред') || normalized.includes('важ') ? 'amber' : normalized ? 'green' : 'gray' }
function isRegistered(value = '') { return ['зарегистрирован', 'зарегистрировано'].includes(value.trim().toLocaleLowerCase('ru')) }
function dueLabel(value) { if (!value) return 'Дата не указана'; const days = Math.ceil((new Date(`${value}T00:00:00`) - new Date(`${todayISO()}T00:00:00`)) / 86400000); return days > 0 ? `Через ${days} дн.` : 'Требует внимания' }
