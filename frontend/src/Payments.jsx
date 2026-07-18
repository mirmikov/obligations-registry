import { useEffect, useState } from 'react'
import { CalendarDays, Download, RefreshCw } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'

export default function Payments({ notify }) {
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState({ approval_date: '', legal_entity: '', account_type: '' })
  const [data, setData] = useState({ items: [], count: 0, amount: 0 })
  const [loading, setLoading] = useState(true)
  const query = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([,v]) => v))).toString()
  const load = () => { setLoading(true); request(`/api/payment-register?${query}`).then(setData).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  useEffect(() => { request('/api/references').then(setRefs).catch(e => notify(e.message,'error')) }, [])
  useEffect(load, [query])
  return <div className="page payments-page">
    <PageHeader eyebrow="Платёжный реестр" title="Обязательства к оплате" subtitle="Согласованные платежи по выбранным условиям" actions={<><button className="secondary" onClick={load}><RefreshCw size={17}/>Обновить</button><button className="primary" onClick={() => download(`/api/obligations/export.xlsx?status=${encodeURIComponent('К оплате')}&${query}`, 'К оплате.xlsx')}><Download size={17}/>Выгрузить</button></>}/>
    <section className="payment-toolbar"><label><span>Дата утверждения</span><DateInput value={filters.approval_date} onChange={value => setFilters({...filters,approval_date:value})} aria-label="Дата утверждения"/></label><label><span>Юридическое лицо</span><select value={filters.legal_entity} onChange={e => setFilters({...filters,legal_entity:e.target.value})}><option value="">Все юрлица</option>{(refs.legal_entities||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label><label><span>Признак учёта</span><select value={filters.account_type} onChange={e => setFilters({...filters,account_type:e.target.value})}><option value="">Все</option>{(refs.account_types||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label></section>
    <section className="payment-summary"><div><CalendarDays/><span>Количество платежей<strong>{data.count}</strong></span></div><div><span>Общая сумма<strong>{money(data.amount)}</strong></span></div></section>
    <section className="payment-list panel"><div className="payment-head"><span>Признак учёта</span><span>Юрлицо</span><span>Контрагент</span><span>Статья затрат</span><span>Документ</span><span>Срок оплаты</span><span>Срочность</span><span>Сумма</span></div>{loading ? <div className="loading-line"/> : data.items.length === 0 ? <div className="empty-state"><CalendarDays size={28}/><strong>По выбранным условиям платежей нет</strong><span>Выберите другую дату или юридическое лицо</span></div> : data.items.map(item => <div className={`payment-row ${item.urgency === 'Критическая' ? 'critical' : ''}`} key={item.id}><span>{item.account_type || '—'}</span><span>{item.legal_entity || '—'}</span><span><strong>{item.counterparty || '—'}</strong></span><span>{item.cost_category || '—'}</span><span>{item.document_number || '—'}</span><span>{shortDate(item.planned_payment_date)}</span><span><i/>{item.urgency || 'Обычная'}</span><span>{money(item.amount)}</span></div>)}</section>
  </div>
}
