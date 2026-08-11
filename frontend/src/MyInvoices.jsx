import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, CalendarDays, Check, CheckCircle2, ChevronDown, CircleDollarSign, FileCheck2, RefreshCw, RotateCcw, Search, UserRoundCheck, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { filterMyInvoices, summarizeMyInvoices, uniqueInvoiceValues } from './myInvoicesView'
import './myInvoices.css'

const emptyData = { responsibles: [], items: [] }
const emptyFilters = {
  query: '', status: '', legalEntity: '', dateFrom: '', dateTo: '',
  plannedDate: '', counterparty: [], costCategory: '', approvalDate: '', actualPaymentDate: '', responsible: '',
}

export default function MyInvoices({ notify }) {
  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState(emptyFilters)
  const load = () => {
    setLoading(true)
    request('/api/my-invoices').then(setData).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const statuses = useMemo(() => uniqueInvoiceValues(data.items, 'status'), [data.items])
  const legalEntities = useMemo(() => uniqueInvoiceValues(data.items, 'legal_entity'), [data.items])
  const counterparties = useMemo(() => uniqueInvoiceValues(data.items, 'counterparty'), [data.items])
  const costCategories = useMemo(() => uniqueInvoiceValues(data.items, 'cost_category'), [data.items])
  const responsibles = useMemo(() => uniqueInvoiceValues(data.items, 'responsible'), [data.items])
  const filtered = useMemo(() => filterMyInvoices(data.items, filters), [data.items, filters])
  const summary = useMemo(() => summarizeMyInvoices(filtered), [filtered])
  const hasFilters = Object.values(filters).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))
  const updateFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const clearFilters = () => setFilters(emptyFilters)

  return <div className="page my-invoices-page">
    <PageHeader eyebrow="Личный кабинет" title="Мои счета" subtitle="Статусы и сроки платежей, назначенных вам как ответственному" actions={<button className="secondary" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>Обновить</button>}/>

    {!loading && data.responsibles.length === 0 ? <section className="panel my-invoices-unassigned">
      <UserRoundCheck size={36}/><div><h2>Ответственный ещё не привязан</h2><p>Попросите администратора открыть «Справочники → Ответственные» и выбрать вашу учётную запись. После привязки здесь автоматически появятся все ваши счета.</p></div>
    </section> : <>
      <section className="my-invoices-owner panel"><UserRoundCheck size={20}/><div><span>Ваши значения в справочнике ответственных</span><strong>{data.responsibles.join(' · ') || 'Загрузка…'}</strong></div></section>

      <section className="my-invoices-kpis">
        <InvoiceKPI icon={FileCheck2} label="Все счета" value={summary.count} amount={summary.amount} tone="teal"/>
        <InvoiceKPI icon={CalendarClock} label="Зарегистрировано" value={summary.registeredCount} amount={summary.registeredAmount} tone="blue"/>
        <InvoiceKPI icon={CircleDollarSign} label="К оплате" value={summary.payableCount} amount={summary.payableAmount} tone="amber"/>
        <InvoiceKPI icon={CheckCircle2} label="Оплачено" value={summary.paidCount} amount={summary.paidAmount} tone="mint"/>
        <InvoiceKPI icon={CalendarClock} label="Просрочено" value={summary.overdueCount} amount={summary.overdueAmount} tone="red"/>
      </section>

      <section className="panel my-invoices-filters">
        <label className="my-invoices-search"><span>Поиск</span><div><Search size={16}/><input value={filters.query} onChange={event => updateFilter('query', event.target.value)} placeholder="Контрагент, документ, комментарий…" aria-label="Поиск по моим счетам"/></div></label>
        <InvoiceSelect label="Статус" value={filters.status} options={statuses} allLabel="Все статусы" onChange={value => updateFilter('status', value)}/>
        <InvoiceSelect label="Юридическое лицо" value={filters.legalEntity} options={legalEntities} allLabel="Все юрлица" onChange={value => updateFilter('legalEntity', value)}/>
        <label className="my-invoices-date-filter"><span>Плановая оплата от</span><div className={`my-invoices-date-control ${filters.dateFrom ? 'has-value' : ''}`}><CalendarDays size={16}/><DateInput className="my-invoices-date-input" value={filters.dateFrom} onChange={value => updateFilter('dateFrom', value)} aria-label="Плановая оплата от"/></div></label>
        <label className="my-invoices-date-filter"><span>Плановая оплата до</span><div className={`my-invoices-date-control ${filters.dateTo ? 'has-value' : ''}`}><CalendarDays size={16}/><DateInput className="my-invoices-date-input" value={filters.dateTo} onChange={value => updateFilter('dateTo', value)} aria-label="Плановая оплата до"/></div></label>
        <button type="button" className="secondary my-invoices-reset" onClick={clearFilters} disabled={!hasFilters}><RotateCcw size={15}/>Сбросить</button>
      </section>

      <section className="panel my-invoices-table-card">
        <header><div><h2>Назначенные счета</h2><span>Показано {filtered.length} из {data.items.length}</span></div><strong>{money(summary.amount)}</strong></header>
        <div className="my-invoices-table-scroll">
          <table className="my-invoices-table">
            <thead><tr>
              <InvoiceColumnHead label="Плановая оплата" dateValue={filters.plannedDate} onDateFilter={value => updateFilter('plannedDate', value)}/>
              <InvoiceColumnHead label="Контрагент" value={filters.counterparty} options={counterparties} onFilter={value => updateFilter('counterparty', value)} multiple/>
              <InvoiceColumnHead label="Юрлицо" value={filters.legalEntity} options={legalEntities} onFilter={value => updateFilter('legalEntity', value)}/>
              <th><span className="column-label">Документ</span></th>
              <InvoiceColumnHead label="Статья затрат" value={filters.costCategory} options={costCategories} onFilter={value => updateFilter('costCategory', value)}/>
              <th><span className="column-label">Сумма</span></th>
              <InvoiceColumnHead label="Статус" value={filters.status} options={statuses} onFilter={value => updateFilter('status', value)}/>
              <InvoiceColumnHead label="Дата утверждения" dateValue={filters.approvalDate} onDateFilter={value => updateFilter('approvalDate', value)}/>
              <InvoiceColumnHead label="Фактическая оплата" dateValue={filters.actualPaymentDate} onDateFilter={value => updateFilter('actualPaymentDate', value)}/>
              <InvoiceColumnHead label="Ответственный" value={filters.responsible} options={responsibles} onFilter={value => updateFilter('responsible', value)}/>
            </tr></thead>
            <tbody>{filtered.map(item => <tr key={item.id} className={invoiceRowTone(item)}>
              <td><strong>{shortDate(item.planned_payment_date)}</strong>{isOverdue(item) && <small className="invoice-overdue-label">Просрочено</small>}</td>
              <td><strong>{item.counterparty || '—'}</strong>{item.account_type && <small>{item.account_type}</small>}</td>
              <td>{item.legal_entity || '—'}</td>
              <td><strong>{item.document_number || '—'}</strong><small>{shortDate(item.document_date)}</small></td>
              <td>{item.cost_category || '—'}</td>
              <td className="my-invoice-amount">{money(item.amount)}</td>
              <td><span className={`my-invoice-status ${statusTone(item)}`}>{item.status || 'Не указан'}</span></td>
              <td>{shortDate(item.approval_date)}</td>
              <td>{shortDate(item.actual_payment_date)}</td>
              <td><strong>{item.responsible || '—'}</strong>{item.comment && <small title={item.comment}>{item.comment}</small>}</td>
            </tr>)}</tbody>
          </table>
          {!loading && filtered.length === 0 && <div className="my-invoices-empty"><FileCheck2 size={28}/><strong>{data.items.length ? 'По выбранным фильтрам счетов нет' : 'Для вас пока нет назначенных счетов'}</strong><span>{data.items.length ? 'Измените или сбросьте фильтры.' : 'Новые строки появятся автоматически после назначения ответственного в реестре.'}</span></div>}
        </div>
      </section>
    </>}
  </div>
}

function InvoiceColumnHead({ label, value = '', options, onFilter, dateValue = '', onDateFilter, multiple = false }) {
  const filtered = (Array.isArray(value) ? value.length > 0 : Boolean(value)) || Boolean(dateValue)
  return <th className={filtered ? 'filtered' : ''}><div className="column-head-inner">
    <span className="column-label">{label}</span>
    {onFilter && <InvoiceHeaderFilter label={label} value={value} options={options} onChange={onFilter} multiple={multiple}/>}
    {onDateFilter && <InvoiceDateHeaderFilter label={label} value={dateValue} onChange={onDateFilter}/>}
  </div></th>
}

function InvoiceDateHeaderFilter({ label, value, onChange }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  return <div className={`header-filter date-header-filter ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
    <button ref={triggerRef} type="button" className="header-filter-trigger" aria-label={`Фильтр по дате: ${label}`} aria-expanded={open} onClick={() => setOpen(current => !current)}><CalendarDays size={13}/>{value && <i/>}</button>
    {open && <DateInput value={value} onChange={next => { onChange(next); setOpen(false) }} onClose={() => setOpen(false)} closeOnScroll={false} anchorRef={triggerRef} triggerOnly aria-label={`Дата фильтра: ${label}`} autoFocus/>}
  </div>
}

function InvoiceHeaderFilter({ label, value, options = [], onChange, multiple = false }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const normalizedOptions = useMemo(() => [...new Set(options.map(option => String(option || '').trim()).filter(Boolean))], [options])
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('ru-RU')
    return term ? normalizedOptions.filter(option => option.toLocaleLowerCase('ru-RU').includes(term)) : normalizedOptions
  }, [search, normalizedOptions])
  const selectedValues = multiple ? (Array.isArray(value) ? value : value ? [value] : []) : value ? [value] : []
  useEffect(() => {
    if (!open) return undefined
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
        <button type="button" className={!selectedValues.length ? 'selected' : ''} onClick={() => select('')} role="option" aria-selected={!selectedValues.length}><span>Все значения</span>{!selectedValues.length && <Check size={14}/>}</button>
        {visible.map(option => { const selected = selectedValues.includes(option); return <button type="button" key={option} className={selected ? 'selected' : ''} onClick={() => select(option)} title={option} role="option" aria-selected={selected}><span>{option}</span>{selected && <Check size={14}/>}</button> })}
        {!visible.length && <p>Ничего не найдено</p>}
      </div>
    </div>}
  </div>
}

function InvoiceKPI({ icon: Icon, label, value, amount, tone }) {
  return <article className={`my-invoice-kpi ${tone}`}><div><Icon size={18}/></div><span>{label}</span><strong>{value}</strong><small>{money(amount)}</small></article>
}

function InvoiceSelect({ label, value, options, allLabel, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  const choose = next => { onChange(next); setOpen(false) }
  return <label className={`my-invoices-select ${open ? 'is-open' : ''}`} ref={rootRef}><span>{label}</span>
    <button type="button" onClick={() => setOpen(current => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value || allLabel}`}><span>{value || allLabel}</span><ChevronDown size={15}/></button>
    {open && <div role="listbox" aria-label={`Выбор: ${label}`}><button type="button" role="option" aria-selected={!value} className={!value ? 'selected' : ''} onClick={() => choose('')}><span>{allLabel}</span>{!value && <Check size={14}/>}</button>{options.map(option => <button type="button" key={option} role="option" aria-selected={option === value} className={option === value ? 'selected' : ''} onClick={() => choose(option)}><span>{option}</span>{option === value && <Check size={14}/>}</button>)}</div>}
  </label>
}

function statusTone(item) {
  if (item.actual_payment_date || item.status === 'Оплачено') return 'paid'
  if (item.status === 'К оплате') return 'payable'
  if (item.status === 'Отменено') return 'cancelled'
  return 'registered'
}
function isOverdue(item) { return Boolean(item.planned_payment_date && item.planned_payment_date < todayISO() && !item.actual_payment_date && item.status !== 'Оплачено' && item.status !== 'Отменено') }
function invoiceRowTone(item) { return isOverdue(item) ? 'is-overdue' : '' }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
