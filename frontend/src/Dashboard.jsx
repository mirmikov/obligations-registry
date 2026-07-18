import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CircleCheck, Landmark, RefreshCw, WalletCards } from 'lucide-react'
import { request } from './api'
import { money, PageHeader } from './App'

export default function Dashboard({ notify }) {
  const [data, setData] = useState(null)
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10))
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); request(`/api/dashboard?as_of=${asOf}`).then(setData).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  useEffect(load, [asOf])
  if (!data) return <div className="page"><PageHeader eyebrow="Управленческая панель" title="Сводка по обязательствам"/><div className="skeleton-grid"><i/><i/><i/><i/></div></div>
  const totals = data.totals
  return <div className="page dashboard-page">
    <PageHeader eyebrow="Управленческая панель" title="Сводка по обязательствам" subtitle="Актуальная картина по всему реестру" actions={<><label className="date-control">На дату<input type="date" value={asOf} onChange={e => setAsOf(e.target.value)}/></label><button className="icon-button" onClick={load}><RefreshCw size={18}/></button></>}/>
    <section className="kpi-grid">
      <KPI icon={WalletCards} label="Всего в реестре" value={money(totals.amount)} detail={`${totals.count.toLocaleString('ru-RU')} обязательств`} tone="ink"/>
      <KPI icon={AlertTriangle} label="Просрочено" value={money(totals.overdue_amount)} detail={`${totals.overdue_count} обязательств`} tone="danger"/>
      <KPI icon={CalendarClock} label="Срок в ближайшие 3 дня" value={money(totals.due_soon_amount)} detail={`${totals.due_soon_count} обязательств`} tone="warning"/>
      <KPI icon={Landmark} label="Среднее обязательство" value={money(totals.amount / Math.max(totals.count, 1))} detail="по всему реестру" tone="mint"/>
    </section>
    <section className="dashboard-grid">
      <div className="panel span-2"><PanelHead title="Платёжный календарь" subtitle="Сумма по плановой дате оплаты"/><MonthlyChart items={data.by_month}/></div>
      <div className="panel"><PanelHead title="По статусам" subtitle="Структура реестра"/><StatusRing items={data.by_status}/></div>
      <div className="panel span-2"><PanelHead title="Статьи затрат" subtitle="Крупнейшие категории"/><BarList items={data.by_category.slice(0, 8)}/></div>
      <div className="panel"><PanelHead title="Юридические лица" subtitle="Распределение суммы"/><EntityList items={data.by_entity}/></div>
    </section>
  </div>
}

function KPI({ icon: Icon, label, value, detail, tone }) { return <article className={`kpi ${tone}`}><div className="kpi-icon"><Icon size={21}/></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article> }
function PanelHead({ title, subtitle }) { return <div className="panel-head"><div><h3>{title}</h3><span>{subtitle}</span></div></div> }
function BarList({ items }) { const max = Math.max(...items.map(i => i.amount), 1); return <div className="bar-list">{items.map((item, index) => <div className="bar-row" key={item.label}><div><span>{item.label}</span><strong>{money(item.amount)}</strong></div><div className="bar-track"><i style={{ width: `${Math.max(2, item.amount / max * 100)}%`, '--delay': `${index * 35}ms` }}/></div></div>)}</div> }
function EntityList({ items }) { return <div className="entity-list">{items.map((item, index) => <div key={item.label}><span className={`entity-dot dot-${index}`}/><div><strong>{item.label}</strong><span>{item.count} записей</span></div><b>{money(item.amount)}</b></div>)}</div> }
function StatusRing({ items }) {
  const total = items.reduce((sum, item) => sum + item.amount, 0) || 1
  const colors = ['#1c6b5a', '#4f8f82', '#f0a55b', '#a86145', '#8b94a0']
  const gradient = useMemo(() => { let start = 0; return `conic-gradient(${items.map((item, i) => { const end = start + item.amount / total * 100; const part = `${colors[i % colors.length]} ${start}% ${end}%`; start = end; return part }).join(',')})` }, [items, total])
  return <div className="status-wrap"><div className="ring" style={{ background: gradient }}><div><CircleCheck size={20}/><strong>{items.reduce((s, i) => s + i.count, 0)}</strong><span>записей</span></div></div><div className="ring-legend">{items.map((item, i) => <div key={item.label}><i style={{ background: colors[i % colors.length] }}/><span>{item.label}</span><b>{Math.round(item.amount / total * 100)}%</b></div>)}</div></div>
}
function MonthlyChart({ items }) {
  const recent = items.slice(-12), max = Math.max(...recent.map(i => i.amount), 1)
  return <div className="monthly-chart">{recent.map(item => <div className="month-col" key={item.label}><div className="month-bar-wrap"><span>{money(item.amount)}</span><i style={{ height: `${Math.max(3, item.amount / max * 100)}%` }}/></div><small>{item.label.slice(5)}.{item.label.slice(2, 4)}</small></div>)}</div>
}
