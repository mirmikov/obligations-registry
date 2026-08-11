import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Check, CheckCircle2, ChevronDown, CircleDollarSign, FileCheck2, RefreshCw, RotateCcw, Search, UserRoundCheck } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { filterMyInvoices, summarizeMyInvoices, uniqueInvoiceValues } from './myInvoicesView'
import './myInvoices.css'

const emptyData = { responsibles: [], items: [] }

export default function MyInvoices({ notify }) {
  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ query: '', status: '', legalEntity: '', dateFrom: '', dateTo: '' })
  const load = () => {
    setLoading(true)
    request('/api/my-invoices').then(setData).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const statuses = useMemo(() => uniqueInvoiceValues(data.items, 'status'), [data.items])
  const legalEntities = useMemo(() => uniqueInvoiceValues(data.items, 'legal_entity'), [data.items])
  const filtered = useMemo(() => filterMyInvoices(data.items, filters), [data.items, filters])
  const summary = useMemo(() => summarizeMyInvoices(filtered), [filtered])
  const hasFilters = Object.values(filters).some(Boolean)
  const updateFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const clearFilters = () => setFilters({ query: '', status: '', legalEntity: '', dateFrom: '', dateTo: '' })

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
        <label><span>Плановая оплата от</span><DateInput value={filters.dateFrom} onChange={value => updateFilter('dateFrom', value)} aria-label="Плановая оплата от"/></label>
        <label><span>Плановая оплата до</span><DateInput value={filters.dateTo} onChange={value => updateFilter('dateTo', value)} aria-label="Плановая оплата до"/></label>
        <button type="button" className="secondary my-invoices-reset" onClick={clearFilters} disabled={!hasFilters}><RotateCcw size={15}/>Сбросить</button>
      </section>

      <section className="panel my-invoices-table-card">
        <header><div><h2>Назначенные счета</h2><span>Показано {filtered.length} из {data.items.length}</span></div><strong>{money(summary.amount)}</strong></header>
        <div className="my-invoices-table-scroll">
          <table className="my-invoices-table">
            <thead><tr><th>Плановая оплата</th><th>Контрагент</th><th>Юрлицо</th><th>Документ</th><th>Статья затрат</th><th>Сумма</th><th>Статус</th><th>Дата утверждения</th><th>Фактическая оплата</th><th>Ответственный</th></tr></thead>
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

