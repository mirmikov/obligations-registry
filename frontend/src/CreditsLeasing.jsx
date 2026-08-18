import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, Landmark, Layers3, RefreshCw, WalletCards, X } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { CREDIT_APPROVAL_STATUSES, creditApprovalUpdatePayload, groupCreditSchedule, summarizeCreditDetails } from './creditsLeasingView'
import { canApproveObligations } from './permissions'
import { withDerivedObligationValues } from './obligationValues'
import './creditsApproval.css'

const emptyData = { entities: [], creditors: [], months: [], payments: [], totals: {} }

export default function CreditsLeasing({ user, notify }) {
  const [data, setData] = useState(emptyData)
  const [entity, setEntity] = useState('')
  const [asOf, setAsOf] = useState(todayISO())
  const [loading, setLoading] = useState(true)
  const [monthScope, setMonthScope] = useState('12')
  const [scheduleMode, setScheduleMode] = useState('upcoming')
  const [creditor, setCreditor] = useState('')
  const [shownPeriods, setShownPeriods] = useState(8)
  const [details, setDetails] = useState(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(() => new Set())
  const detailsRequest = useRef(0)

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ as_of: asOf })
    if (entity) params.set('legal_entity', entity)
    request(`/api/reports/credits-leasing?${params}`).then(setData).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(load, [entity, asOf])

  const chartMonths = useMemo(() => filterMonths(data.months, asOf, monthScope), [data.months, asOf, monthScope])
  const maxMonth = Math.max(1, ...chartMonths.map(item => item.total_amount))
  const schedule = useMemo(() => groupCreditSchedule(data.payments, { asOf, scheduleMode, creditor }).map(period => ({ ...period, label: monthName(period.month), year: period.month.slice(0, 4) })), [data.payments, asOf, scheduleMode, creditor])
  const visibleSchedule = schedule.slice(0, shownPeriods)
  const totals = data.totals || {}

  const chooseScheduleMode = value => { setScheduleMode(value); setShownPeriods(8) }
  const chooseCreditor = value => { setCreditor(current => current === value ? '' : value); setShownPeriods(8) }
  const closeDetails = () => { detailsRequest.current += 1; setDetails(null); setDetailsLoading(false) }
  const openDay = async day => {
    const requestID = ++detailsRequest.current
    const selectedEntity = data.selected_entity || entity
    setDetails({ date: day.date, legal_entity: selectedEntity, creditor, items: [], count: day.count, amount: day.total, outstanding_amount: day.outstanding })
    setDetailsLoading(true)
    const params = new URLSearchParams({ date: day.date, legal_entity: selectedEntity })
    day.items.forEach(item => params.append('counterparty', item.counterparty))
    try {
      const result = await request(`/api/reports/credits-leasing/details?${params}`)
      if (detailsRequest.current === requestID) setDetails({ ...result, creditor })
    } catch (error) {
      if (detailsRequest.current === requestID) {
        notify(error.message, 'error')
        setDetails(null)
      }
    } finally {
      if (detailsRequest.current === requestID) setDetailsLoading(false)
    }
  }

  const saveDetailField = async (item, field, value) => {
    const key = `${item.id}:${field}`
    const currentDetails = details
    const optimisticItem = withDerivedObligationValues({ ...item, [field]: value }, field)
    setDetailsSaving(current => new Set(current).add(key))
    setDetails(current => current ? {
      ...current,
      items: current.items.map(row => row.id === item.id ? optimisticItem : row),
    } : current)
    try {
      await request('/api/reports/credits-leasing/obligations/bulk', {
        method: 'POST',
        body: JSON.stringify(creditApprovalUpdatePayload(item.id, field, value)),
      })
      const reportParams = new URLSearchParams({ as_of: asOf })
      if (entity) reportParams.set('legal_entity', entity)
      const detailParams = new URLSearchParams({ date: currentDetails.date, legal_entity: currentDetails.legal_entity })
      currentDetails.counterparties?.forEach(counterparty => detailParams.append('counterparty', counterparty))
      const [reportResult, detailsResult] = await Promise.all([
        request(`/api/reports/credits-leasing?${reportParams}`),
        request(`/api/reports/credits-leasing/details?${detailParams}`),
      ])
      setData(reportResult)
      setDetails(current => current?.date === currentDetails.date && current?.legal_entity === currentDetails.legal_entity
        ? { ...detailsResult, creditor: current.creditor }
        : current)
      notify(field === 'status' ? 'Статус обновлён' : value ? 'Дата утверждения обновлена' : 'Дата утверждения очищена')
      return true
    } catch (error) {
      setDetails(current => current ? {
        ...current,
        items: current.items.map(row => {
          if (row.id !== item.id || row[field] !== value) return row
          const reverted = { ...row, [field]: item[field] }
          if (row.status === optimisticItem.status) reverted.status = item.status
          return reverted
        }),
      } : current)
      notify(error.message, 'error')
      return false
    } finally {
      setDetailsSaving(current => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  return <div className="page credits-page">
    <PageHeader eyebrow="Подраздел реестра" title="Кредиты и лизинги" subtitle="Платёжный график по статье затрат в разрезе юрлица и кредиторов" actions={<button className="secondary" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>Обновить</button>}/>

    <section className="credits-toolbar">
      <label><span>Юридическое лицо</span><select value={data.selected_entity || entity} onChange={event => { setEntity(event.target.value); setCreditor(''); setShownPeriods(8) }}><option value="">Все юридические лица</option>{data.entities.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <label><span>Дата отчёта</span><DateInput value={asOf} onChange={setAsOf} aria-label="Дата отчёта"/></label>
      <div className="credits-source-note"><Layers3 size={17}/><div><strong>{data.category || 'Кредиты и лизинг'}</strong><span>Плановая дата оплаты × контрагент × сумма</span></div></div>
    </section>

    {loading && !data.entities.length ? <CreditsSkeleton/> : !data.entities.length ? <div className="credits-empty"><Landmark size={30}/><strong>Нет обязательств по кредитам и лизингу</strong><span>Добавьте записи с соответствующей статьёй затрат в реестр.</span></div> : <>
      <section className="credits-kpis">
        <ReportKPI icon={Landmark} label="Весь график" value={money(totals.total_amount)} note={`${totals.count || 0} обязательств`} tone="teal"/>
        <ReportKPI icon={CheckCircle2} label="Уже оплачено" value={money(totals.paid_amount)} note={`${share(totals.paid_amount, totals.total_amount)} графика`} tone="mint"/>
        <ReportKPI icon={WalletCards} label="Остаток к оплате" value={money(totals.outstanding_amount)} note={`${share(totals.outstanding_amount, totals.total_amount)} графика`} tone="amber"/>
        <ReportKPI icon={AlertTriangle} label="Просрочено" value={money(totals.overdue_amount)} note={`${totals.overdue_count || 0} ${paymentWord(totals.overdue_count || 0)}`} tone="red"/>
        <ReportKPI icon={CalendarClock} label="Ближайшие 30 дней" value={money(totals.next_30_amount)} note={`от ${shortDate(asOf)}`} tone="violet"/>
      </section>

      <section className="credits-layout">
        <article className="panel credits-creditors-panel">
          <div className="panel-head"><h3>Структура обязательств</h3><span>Нажмите на кредитора, чтобы отфильтровать график</span></div>
          <div className="creditor-cards">{data.creditors.map((item, index) => <button type="button" key={item.name} className={`creditor-card ${creditor === item.name ? 'active' : ''}`} onClick={() => chooseCreditor(item.name)} style={{ '--creditor-color': creditorColor(index) }}>
            <div className="creditor-card-head"><span><i/>{item.name}</span><strong>{money(item.total_amount)}</strong></div>
            <div className="creditor-share"><i style={{ width: shareRaw(item.total_amount, totals.total_amount) }}/></div>
            <div className="creditor-card-foot"><span>{share(item.total_amount, totals.total_amount)} всего</span><span>Остаток <b>{money(item.outstanding_amount)}</b></span><span>{item.count} {paymentWord(item.count)}</span></div>
          </button>)}</div>
        </article>

        <article className="panel credits-chart-panel">
          <div className="panel-head credits-panel-head"><div><h3>Платёжная нагрузка</h3><span>Суммы по плановой дате оплаты</span></div><div className="report-switch">{[['12','12 мес.'],['24','24 мес.'],['all','Весь график']].map(option => <button key={option[0]} className={monthScope === option[0] ? 'active' : ''} onClick={() => setMonthScope(option[0])}>{option[1]}</button>)}</div></div>
          <div className="credits-chart-legend"><span><i className="paid"/>Оплачено</span><span><i className="outstanding"/>К оплате</span></div>
          <div className="credits-month-chart">{chartMonths.map(item => <div className="credits-month" key={item.month} title={`${monthLabel(item.month)} · ${money(item.total_amount)}`}>
            <div className="credits-month-value">{compactMoney(item.total_amount)}</div>
            <div className="credits-month-bar" style={{ height: `${Math.max(5, item.total_amount / maxMonth * 100)}%` }}><i className="outstanding" style={{ height: `${shareNumber(item.outstanding_amount, item.total_amount)}%` }}/><i className="paid" style={{ height: `${shareNumber(item.paid_amount, item.total_amount)}%` }}/></div>
            <small>{monthShort(item.month)}</small>
          </div>)}</div>
          {!chartMonths.length && <div className="chart-empty">В выбранном периоде платежей нет</div>}
        </article>
      </section>

      <section className="panel credits-schedule-panel">
        <div className="panel-head credits-panel-head"><div><h3>Календарный график платежей</h3><span>{creditor ? `Кредитор: ${creditor}` : 'Все кредиторы'} · вместо строк сводной таблицы</span></div><div className="report-switch">{[['upcoming','Предстоящие'],['overdue','Просроченные'],['all','Весь график']].map(option => <button key={option[0]} className={scheduleMode === option[0] ? 'active' : ''} onClick={() => chooseScheduleMode(option[0])}>{option[1]}</button>)}</div></div>
        {creditor && <button className="clear-creditor" onClick={() => chooseCreditor(creditor)}>Показать всех кредиторов</button>}
        <div className="schedule-periods">{visibleSchedule.map(period => <SchedulePeriod key={period.month} period={period} onOpenDay={openDay}/>)}</div>
        {!schedule.length && <div className="schedule-empty"><CalendarClock size={27}/><strong>В этом срезе платежей нет</strong><span>Измените режим или выберите другого кредитора.</span></div>}
        {shownPeriods < schedule.length && <button className="schedule-more" onClick={() => setShownPeriods(value => value + 8)}>Показать ещё периоды</button>}
      </section>
    </>}
    {details && <CreditDayDetails details={details} loading={detailsLoading} savingCells={detailsSaving} editable={canApproveObligations(user)} onCommit={saveDetailField} onClose={closeDetails}/>}
  </div>
}

function ReportKPI({ icon: Icon, label, value, note, tone }) { return <article className={`report-kpi ${tone}`}><div className="report-kpi-icon"><Icon size={19}/></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article> }

function SchedulePeriod({ period, onOpenDay }) {
  return <article className="schedule-period"><header><div><span>{period.year}</span><strong>{period.label}</strong></div><b>{money(period.total)}</b></header><div className="schedule-days">{period.days.map(day => <button type="button" className={`schedule-day ${day.overdue ? 'overdue' : ''}`} key={day.date} onClick={() => onOpenDay(day)} aria-label={`Открыть ${day.count} ${paymentWord(day.count)} за ${fullDate(day.date)}`}>
    <div className="schedule-date"><strong>{dayNumber(day.date)}</strong><span>{weekday(day.date)}</span></div>
    <div className="schedule-payments">{day.items.map(item => <div className="schedule-payment" key={`${day.date}-${item.counterparty}`}><div><strong>{item.counterparty}</strong><span>{item.count} {paymentWord(item.count)}{item.overdue ? ' · просрочено' : ''}</span></div><b>{money(item.total_amount)}</b></div>)}</div>
    <div className="schedule-day-total"><span>Итого</span><strong>{money(day.total)}</strong>{day.outstanding > 0 && <small>К оплате {money(day.outstanding)}</small>}<em>Открыть <ChevronRight size={13}/></em></div>
  </button>)}</div></article>
}

function CreditDayDetails({ details, loading, savingCells, editable, onCommit, onClose }) {
  useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  const summary = summarizeCreditDetails(details.items)
  const count = loading ? details.count : summary.count
  const total = loading ? details.amount : summary.total
  return <div className="modal-backdrop credits-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal credits-detail-modal" role="dialog" aria-modal="true" aria-label={`Платежи за ${fullDate(details.date)}`}>
      <header className="modal-head credits-detail-head">
        <div><p className="eyebrow">Кредиты и лизинги · {details.legal_entity || 'Все юридические лица'}</p><h2>Платежи за {fullDate(details.date)}</h2><span>{count || 0} {paymentWord(count || 0)} · {money(total)}</span></div>
        <button type="button" onClick={onClose} title="Закрыть" aria-label="Закрыть"><X/></button>
      </header>
      <div className="credits-detail-summary">
        <div><span>Всего</span><strong>{money(total)}</strong></div>
        <div><span>Оплачено</span><strong>{money(loading ? 0 : summary.paid)}</strong></div>
        <div><span>Остаток</span><strong>{money(loading ? details.outstanding_amount : summary.outstanding)}</strong></div>
      </div>
      <div className="credits-detail-scroll">
        {loading ? <div className="credits-detail-loading"><RefreshCw size={22} className="spin"/><span>Загружаем платежи выбранного дня…</span></div>
          : !details.items.length ? <div className="credits-detail-loading"><CalendarClock size={25}/><span>Платежи не найдены</span></div>
            : <table className="credits-detail-table"><thead><tr><th>№</th>{!details.legal_entity && <th>Юрлицо</th>}<th>Кредитор</th><th>Документ</th><th>Назначение и комментарий</th><th>График</th><th>Сумма</th><th>Статус</th><th>Дата утверждения</th><th>Факт. оплата</th><th>Ответственный</th></tr></thead>
              <tbody>{details.items.map((item, index) => <tr key={item.id}><td>{index + 1}</td>{!details.legal_entity && <td><strong>{item.legal_entity || 'Не указано'}</strong></td>}<td><strong>{item.counterparty || '—'}</strong></td><td><strong>{item.document_number || '—'}</strong><small>{shortDate(item.document_date)}</small></td><td><strong>{item.source_note || '—'}</strong>{item.comment && <small>{item.comment}</small>}</td><td>{installmentLabel(item)}</td><td className="credits-detail-amount">{money(item.amount)}</td><CreditStatusCell item={item} saving={savingCells.has(`${item.id}:status`)} editable={editable} onCommit={onCommit}/><CreditApprovalDateCell item={item} saving={savingCells.has(`${item.id}:approval_date`)} editable={editable} onCommit={onCommit}/><td>{shortDate(item.actual_payment_date)}</td><td>{item.responsible || '—'}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={details.legal_entity ? 5 : 6}>Итого · {summary.count} {paymentWord(summary.count)}</td><td>{money(summary.total)}</td><td colSpan="4">Остаток {money(summary.outstanding)}</td></tr></tfoot></table>}
      </div>
      <footer className="modal-footer"><button type="button" className="primary" onClick={onClose}>Закрыть</button></footer>
    </section>
  </div>
}

function CreditStatusCell({ item, saving, editable, onCommit }) {
  const [editing, setEditing] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!editing) return undefined
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setEditing(false) }
    const closeEscape = event => { if (event.key === 'Escape') setEditing(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [editing])
  const choose = async value => {
    if (value === item.status) {
      setEditing(false)
      return
    }
    if (await onCommit(item, 'status', value)) setEditing(false)
  }
  if (!editable) return <td><span className={`credits-detail-status ${statusTone(item)}`}>{item.status || '—'}</span></td>
  return <td ref={rootRef} className={`executive-editable-cell ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`}>
    <button type="button" className="executive-cell-trigger" onClick={() => !saving && setEditing(current => !current)} disabled={saving} aria-label={`Статус: ${item.status || 'не указан'}. Изменить`} aria-expanded={editing}>
      <span className={`credits-detail-status ${statusTone(item)}`}>{item.status || '—'}</span><ChevronDown size={14}/>
    </button>
    {editing && <div className="executive-inline-select" role="listbox" aria-label="Выбор статуса платежа">
      {CREDIT_APPROVAL_STATUSES.map(option => <button type="button" key={option} className={option === item.status ? 'selected' : ''} onClick={() => choose(option)} role="option" aria-selected={option === item.status}><span>{option}</span>{option === item.status && <Check size={14}/>}</button>)}
    </div>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

function CreditApprovalDateCell({ item, saving, editable, onCommit }) {
  const [editing, setEditing] = useState(false)
  if (!editable) return <td>{shortDate(item.approval_date)}</td>
  return <td className={`executive-editable-cell executive-date-cell ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`}>
    {editing
      ? <DateInput className="executive-date-input" value={item.approval_date || ''} onChange={value => { setEditing(false); onCommit(item, 'approval_date', value) }} onClose={() => setEditing(false)} closeOnScroll={false} aria-label="Дата утверждения платежа" autoFocus/>
      : <button type="button" className="executive-cell-trigger executive-date-trigger" onClick={() => !saving && setEditing(true)} disabled={saving} aria-label={`Дата утверждения: ${shortDate(item.approval_date)}. Изменить`}>{shortDate(item.approval_date)}</button>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

function filterMonths(months = [], asOf, scope) {
  if (scope === 'all') return months
  const start = asOf.slice(0, 7)
  const end = addMonths(start, Number(scope) - 1)
  return months.filter(item => item.month >= start && item.month <= end)
}

function addMonths(value, count) { const [year, month] = value.split('-').map(Number); const date = new Date(Date.UTC(year, month - 1 + count, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` }
function share(value, total) { return `${shareNumber(value, total).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%` }
function shareRaw(value, total) { return `${shareNumber(value, total)}%` }
function shareNumber(value, total) { return total > 0 ? Math.min(100, Number(value || 0) / Number(total) * 100) : 0 }
function monthLabel(value) { return new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
function monthName(value) { const text = new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', timeZone: 'UTC' }); return text[0].toUpperCase() + text.slice(1) }
function monthShort(value) { return new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' г.', '') }
function compactMoney(value) { return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0) }
function dayNumber(value) { return value.slice(8, 10) }
function weekday(value) { return new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }) }
function fullDate(value) { return value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—' }
function installmentLabel(item) { return item.installment_count > 1 ? `${item.installment_number || '—'} из ${item.installment_count}` : 'Один платёж' }
function statusTone(item) { return item.status === 'Оплачено' || item.actual_payment_date ? 'paid' : item.status === 'Отменено' ? 'cancelled' : 'outstanding' }
function creditorColor(index) { return ['#267363','#d09249','#806997','#477c9b','#b45d4d'][index % 5] }
function paymentWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'платежей' : last === 1 ? 'платёж' : last >= 2 && last <= 4 ? 'платежа' : 'платежей' }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function CreditsSkeleton() { return <div className="credits-skeleton">{Array.from({ length: 5 }).map((_, index) => <i key={index}/>)}</div> }
