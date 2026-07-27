import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CalendarRange, ChevronRight, Layers3, RefreshCw, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { BLANK_ACCOUNT_TYPE_FILTER } from './filterValues'
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
      <label>
        <span>Юридическое лицо</span>
        <select value={filters.legal_entity} onChange={event => setFilters(current => ({ ...current, legal_entity: event.target.value }))}>
          <option value="">Все юридические лица</option>
          {(refs.legal_entities || []).map(item => <option key={item.id} value={item.value}>{item.value}</option>)}
        </select>
      </label>
      <label>
        <span>Признак учёта</span>
        <select value={filters.account_type} onChange={event => setFilters(current => ({ ...current, account_type: event.target.value }))}>
          <option value="">Все признаки учёта</option>
          <option value={BLANK_ACCOUNT_TYPE_FILTER}>Не выбран (—)</option>
          {(refs.account_types || []).map(item => <option key={item.id} value={item.value}>{item.value}</option>)}
        </select>
      </label>
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
