import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, CalendarRange, Check, ChevronDown, ChevronRight, Layers3, RefreshCw, Search, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { BLANK_ACCOUNT_TYPE_FILTER, filterSelectOptions } from './filterValues'
import { localTodayISO } from './paymentsView'

const periodIcons = {
  overdue: AlertTriangle,
  week: CalendarClock,
  month: CalendarRange,
}

export default function ExecutiveDashboard({ notify }) {
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(() => ({ as_of: localTodayISO(), legal_entity: '', account_type: '' }))
  const [data, setData] = useState({ periods: [] })
  const [loading, setLoading] = useState(true)
  const [details, setDetails] = useState(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString(), [filters])

  useEffect(() => {
    request('/api/references').then(setRefs).catch(error => notify(error.message, 'error'))
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    request(`/api/reports/executive?${query}`)
      .then(result => { if (active) setData(result) })
      .catch(error => { if (active) notify(error.message, 'error') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [query])

  const openDetails = (period, group) => {
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      period: period.key,
      cost_category: group.cost_category,
    })
    setDetails({ period, cost_category: group.cost_category, count: group.count, amount: group.amount, items: [] })
    setDetailsLoading(true)
    request(`/api/reports/executive/details?${params}`)
      .then(setDetails)
      .catch(error => { setDetails(null); notify(error.message, 'error') })
      .finally(() => setDetailsLoading(false))
  }

  const refresh = () => {
    setLoading(true)
    request(`/api/reports/executive?${query}`)
      .then(setData)
      .catch(error => notify(error.message, 'error'))
      .finally(() => setLoading(false))
  }

  return <div className="page executive-page">
    <PageHeader
      eyebrow="Управленческая аналитика"
      title="Панель руководителя"
      subtitle="Контроль зарегистрированных обязательств на выбранную дату"
      actions={<button className="secondary" onClick={refresh} disabled={loading}><RefreshCw size={17}/>Обновить</button>}
    />

    <section className="executive-filters panel">
      <label>
        <span>Дата отчёта</span>
        <DateInput value={filters.as_of} onChange={value => value && setFilters(current => ({ ...current, as_of: value }))} aria-label="Дата отчёта"/>
      </label>
      <ExecutiveFilterSelect
        label="Юридическое лицо"
        value={filters.legal_entity}
        allLabel="Все юридические лица"
        options={(refs.legal_entities || []).map(item => ({ value: item.value, label: item.value }))}
        onChange={value => setFilters(current => ({ ...current, legal_entity: value }))}
      />
      <ExecutiveFilterSelect
        label="Признак учёта"
        value={filters.account_type}
        allLabel="Все признаки учёта"
        options={[
          { value: BLANK_ACCOUNT_TYPE_FILTER, label: 'Не выбран (—)' },
          ...(refs.account_types || []).map(item => ({ value: item.value, label: item.value })),
        ]}
        onChange={value => setFilters(current => ({ ...current, account_type: value }))}
      />
      <div className="executive-filter-context">
        <span>В расчёте</span>
        <strong>Только статус «Зарегистрирован»</strong>
      </div>
    </section>

    <section className={`executive-grid ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
      {loading && data.periods.length === 0
        ? ['overdue', 'week', 'month'].map(key => <ExecutiveSkeleton key={key}/>)
        : data.periods.map(period => <ExecutivePeriodCard key={period.key} period={period} onSelect={group => openDetails(period, group)}/>)}
    </section>

    {details && <ExecutiveDetails details={details} loading={detailsLoading} onClose={() => setDetails(null)}/>}
  </div>
}

function ExecutiveFilterSelect({ label, value, allLabel, options, onChange }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const selected = options.find(option => option.value === value)
  const visible = useMemo(() => filterSelectOptions(options, search), [options, search])

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  const choose = next => {
    onChange(next)
    setSearch('')
    setOpen(false)
  }

  return <label>
    <span>{label}</span>
    <div ref={rootRef} className={`executive-select ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
      <button type="button" className="executive-select-trigger" onClick={() => { setSearch(''); setOpen(current => !current) }} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${selected?.label || allLabel}`}>
        <span title={selected?.label || allLabel}>{selected?.label || allLabel}</span>
        <ChevronDown size={16}/>
      </button>
      {open && <div className="executive-select-menu">
        <div className="header-filter-search">
          <Search size={15}/>
          <input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск по наименованию" aria-label={`Поиск: ${label}`}/>
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={13}/></button>}
        </div>
        <div className="header-filter-options" role="listbox" aria-label={`Значения: ${label}`}>
          <button type="button" className={!value ? 'selected' : ''} onClick={() => choose('')} role="option" aria-selected={!value}><span>{allLabel}</span>{!value && <Check size={14}/>}</button>
          {visible.map(option => <button type="button" key={option.value} className={option.value === value ? 'selected' : ''} onClick={() => choose(option.value)} title={option.label} role="option" aria-selected={option.value === value}><span>{option.label}</span>{option.value === value && <Check size={14}/>}</button>)}
          {!visible.length && <p>Ничего не найдено</p>}
        </div>
      </div>}
    </div>
  </label>
}

function ExecutivePeriodCard({ period, onSelect }) {
  const Icon = periodIcons[period.key] || Layers3
  const range = period.from ? `${shortDate(period.from)} — ${shortDate(period.to)}` : `до ${shortDate(period.to)}`
  return <article className={`executive-period executive-period-${period.key} panel`}>
    <header>
      <div className="executive-period-icon"><Icon size={21}/></div>
      <div><span>{range}</span><h2>{period.title}</h2></div>
    </header>
    <div className="executive-period-total">
      <div><span>Обязательств</span><strong>{period.count.toLocaleString('ru-RU')}</strong></div>
      <div><span>Общая сумма</span><strong>{money(period.amount)}</strong></div>
    </div>
    <div className="executive-groups">
      <div className="executive-groups-head"><span>Статья затрат</span><span>Кол-во</span><span>Сумма</span><i/></div>
      {period.groups.length === 0
        ? <div className="executive-empty"><Layers3 size={25}/><strong>Обязательств нет</strong><span>По выбранным условиям список пуст</span></div>
        : period.groups.map(group => <button type="button" className="executive-group-row" key={group.cost_category} onClick={() => onSelect(group)}>
          <strong title={group.cost_category}>{group.cost_category}</strong>
          <span>{group.count.toLocaleString('ru-RU')}</span>
          <b>{money(group.amount)}</b>
          <ChevronRight size={17}/>
        </button>)}
    </div>
  </article>
}

function ExecutiveSkeleton() {
  return <article className="executive-period executive-skeleton panel"><div/><div/><div/><div/><div/></article>
}

function ExecutiveDetails({ details, loading, onClose }) {
  return <div className="modal-backdrop executive-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal executive-detail-modal" role="dialog" aria-modal="true" aria-label={`Детализация: ${details.cost_category}`}>
      <header className="modal-head executive-detail-head">
        <div>
          <p className="eyebrow">{details.period.title}</p>
          <h2>{details.cost_category}</h2>
          <span>{details.count.toLocaleString('ru-RU')} обязательств · {money(details.amount)}</span>
        </div>
        <button type="button" onClick={onClose} title="Закрыть" aria-label="Закрыть"><X/></button>
      </header>
      <div className="executive-detail-scroll">
        {loading ? <div className="executive-detail-loading"><div className="loading-line"/><span>Загружаем обязательства…</span></div>
          : details.items.length === 0 ? <div className="executive-empty"><Layers3 size={28}/><strong>Записи не найдены</strong></div>
            : <table className="executive-detail-table">
              <thead><tr>
                <th>Юридическое лицо</th><th>Плановая дата</th><th>Контрагент</th><th>Назначение платежа</th>
                <th>Комментарий</th><th>Сумма</th><th>Ответственный</th><th>Статус</th><th>Дата утверждения</th>
              </tr></thead>
              <tbody>{details.items.map(item => <tr key={item.id}>
                <td>{item.legal_entity || '—'}</td>
                <td>{shortDate(item.planned_payment_date)}</td>
                <td><strong>{item.counterparty || '—'}</strong></td>
                <td>{item.payment_purpose || '—'}</td>
                <td>{item.comment || '—'}</td>
                <td className="executive-detail-amount">{money(item.amount)}</td>
                <td>{item.responsible || '—'}</td>
                <td><span className="executive-status">{item.status}</span></td>
                <td>{shortDate(item.approval_date)}</td>
              </tr>)}</tbody>
              <tfoot><tr><td colSpan="4">Итого</td><td colSpan="2">{money(details.amount)}</td><td colSpan="3">{details.count.toLocaleString('ru-RU')} обязательств</td></tr></tfoot>
            </table>}
      </div>
    </section>
  </div>
}
