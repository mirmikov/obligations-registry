import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, Landmark, Layers3, RefreshCw, WalletCards } from 'lucide-react'
import { request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'

const emptyData = { entities: [], creditors: [], months: [], payments: [], totals: {} }

export default function CreditsLeasing({ notify }) {
  const [data, setData] = useState(emptyData)
  const [entity, setEntity] = useState('')
  const [asOf, setAsOf] = useState(todayISO())
  const [loading, setLoading] = useState(true)
  const [monthScope, setMonthScope] = useState('12')
  const [scheduleMode, setScheduleMode] = useState('upcoming')
  const [creditor, setCreditor] = useState('')
  const [shownPeriods, setShownPeriods] = useState(8)

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ as_of: asOf })
    if (entity) params.set('legal_entity', entity)
    request(`/api/reports/credits-leasing?${params}`).then(setData).catch(error => notify(error.message, 'error')).finally(() => setLoading(false))
  }
  useEffect(load, [entity, asOf])

  const chartMonths = useMemo(() => filterMonths(data.months, asOf, monthScope), [data.months, asOf, monthScope])
  const maxMonth = Math.max(1, ...chartMonths.map(item => item.total_amount))
  const schedule = useMemo(() => groupSchedule(data.payments, { asOf, scheduleMode, creditor }), [data.payments, asOf, scheduleMode, creditor])
  const visibleSchedule = schedule.slice(0, shownPeriods)
  const totals = data.totals || {}

  const chooseScheduleMode = value => { setScheduleMode(value); setShownPeriods(8) }
  const chooseCreditor = value => { setCreditor(current => current === value ? '' : value); setShownPeriods(8) }

  return <div className="page credits-page">
    <PageHeader eyebrow="Подраздел реестра" title="Кредиты и лизинги" subtitle="Платёжный график по статье затрат в разрезе юрлица и кредиторов" actions={<button className="secondary" onClick={load} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>Обновить</button>}/>

    <section className="credits-toolbar">
      <label><span>Юридическое лицо</span><select value={data.selected_entity || entity} onChange={event => { setEntity(event.target.value); setCreditor(''); setShownPeriods(8) }}>{data.entities.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
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
        <div className="schedule-periods">{visibleSchedule.map(period => <SchedulePeriod key={period.month} period={period}/>)}</div>
        {!schedule.length && <div className="schedule-empty"><CalendarClock size={27}/><strong>В этом срезе платежей нет</strong><span>Измените режим или выберите другого кредитора.</span></div>}
        {shownPeriods < schedule.length && <button className="schedule-more" onClick={() => setShownPeriods(value => value + 8)}>Показать ещё периоды</button>}
      </section>
    </>}
  </div>
}

function ReportKPI({ icon: Icon, label, value, note, tone }) { return <article className={`report-kpi ${tone}`}><div className="report-kpi-icon"><Icon size={19}/></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article> }

function SchedulePeriod({ period }) {
  return <article className="schedule-period"><header><div><span>{period.year}</span><strong>{period.label}</strong></div><b>{money(period.total)}</b></header><div className="schedule-days">{period.days.map(day => <div className={`schedule-day ${day.overdue ? 'overdue' : ''}`} key={day.date}>
    <div className="schedule-date"><strong>{dayNumber(day.date)}</strong><span>{weekday(day.date)}</span></div>
    <div className="schedule-payments">{day.items.map(item => <div className="schedule-payment" key={`${day.date}-${item.counterparty}`}><div><strong>{item.counterparty}</strong><span>{item.count} {paymentWord(item.count)}{item.overdue ? ' · просрочено' : ''}</span></div><b>{money(item.total_amount)}</b></div>)}</div>
    <div className="schedule-day-total"><span>Итого</span><strong>{money(day.total)}</strong>{day.outstanding > 0 && <small>К оплате {money(day.outstanding)}</small>}</div>
  </div>)}</div></article>
}

function groupSchedule(payments = [], { asOf, scheduleMode, creditor }) {
  const filtered = payments.filter(item => {
    if (creditor && item.counterparty !== creditor) return false
    if (scheduleMode === 'upcoming') return item.date >= asOf && item.outstanding_amount > 0
    if (scheduleMode === 'overdue') return item.date < asOf && item.outstanding_amount > 0
    return true
  })
  const months = new Map()
  for (const item of filtered) {
    const month = item.date.slice(0, 7)
    if (!months.has(month)) months.set(month, new Map())
    const days = months.get(month)
    if (!days.has(item.date)) days.set(item.date, [])
    days.get(item.date).push(item)
  }
  return [...months.entries()].map(([month, days]) => {
    const dayItems = [...days.entries()].map(([date, items]) => ({ date, items, total: sum(items, 'total_amount'), outstanding: sum(items, 'outstanding_amount'), overdue: items.some(item => item.overdue) }))
    return { month, label: monthName(month), year: month.slice(0, 4), days: dayItems, total: dayItems.reduce((value, day) => value + day.total, 0) }
  })
}

function filterMonths(months = [], asOf, scope) {
  if (scope === 'all') return months
  const start = asOf.slice(0, 7)
  const end = addMonths(start, Number(scope) - 1)
  return months.filter(item => item.month >= start && item.month <= end)
}

function addMonths(value, count) { const [year, month] = value.split('-').map(Number); const date = new Date(Date.UTC(year, month - 1 + count, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` }
function sum(items, field) { return items.reduce((value, item) => value + Number(item[field] || 0), 0) }
function share(value, total) { return `${shareNumber(value, total).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%` }
function shareRaw(value, total) { return `${shareNumber(value, total)}%` }
function shareNumber(value, total) { return total > 0 ? Math.min(100, Number(value || 0) / Number(total) * 100) : 0 }
function monthLabel(value) { return new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
function monthName(value) { const text = new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', timeZone: 'UTC' }); return text[0].toUpperCase() + text.slice(1) }
function monthShort(value) { return new Date(`${value}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' г.', '') }
function compactMoney(value) { return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0) }
function dayNumber(value) { return value.slice(8, 10) }
function weekday(value) { return new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }) }
function creditorColor(index) { return ['#267363','#d09249','#806997','#477c9b','#b45d4d'][index % 5] }
function paymentWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'платежей' : last === 1 ? 'платёж' : last >= 2 && last <= 4 ? 'платежа' : 'платежей' }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function CreditsSkeleton() { return <div className="credits-skeleton">{Array.from({ length: 5 }).map((_, index) => <i key={index}/>)}</div> }
