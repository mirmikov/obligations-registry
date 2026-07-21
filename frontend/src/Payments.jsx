import { useEffect, useState } from 'react'
import { CalendarDays, Download, Printer, RefreshCw } from 'lucide-react'
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
    <PageHeader eyebrow="Платёжный реестр" title="Обязательства к оплате" subtitle="Согласованные платежи по выбранным условиям" actions={<><button className="secondary" onClick={load}><RefreshCw size={17}/>Обновить</button><button className="secondary" onClick={() => window.print()} disabled={loading}><Printer size={17}/>Печать</button><button className="primary" onClick={() => download(`/api/obligations/export.xlsx?status=${encodeURIComponent('К оплате')}&${query}`, 'К оплате.xlsx')}><Download size={17}/>Выгрузить</button></>}/>
    <section className="payment-toolbar"><label><span>Дата утверждения</span><DateInput value={filters.approval_date} onChange={value => setFilters({...filters,approval_date:value})} aria-label="Дата утверждения"/></label><label><span>Юридическое лицо</span><select value={filters.legal_entity} onChange={e => setFilters({...filters,legal_entity:e.target.value})}><option value="">Все юрлица</option>{(refs.legal_entities||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label><label><span>Признак учёта</span><select value={filters.account_type} onChange={e => setFilters({...filters,account_type:e.target.value})}><option value="">Все</option>{(refs.account_types||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label></section>
    <section className="payment-summary"><div><CalendarDays/><span>Количество платежей<strong>{data.count}</strong></span></div><div><span>Общая сумма<strong>{money(data.amount)}</strong></span></div></section>
    <section className="payment-list panel"><div className="payment-head"><span>Признак учёта</span><span>Юрлицо</span><span>Контрагент</span><span>Статья затрат</span><span>Документ</span><span>Срок оплаты</span><span>Срочность</span><span>Сумма</span></div>{loading ? <div className="loading-line"/> : data.items.length === 0 ? <div className="empty-state"><CalendarDays size={28}/><strong>По выбранным условиям платежей нет</strong><span>Выберите другую дату или юридическое лицо</span></div> : data.items.map(item => <div className={`payment-row ${item.urgency === 'Критическая' ? 'critical' : ''}`} key={item.id}><span>{item.account_type || '—'}</span><span>{item.legal_entity || '—'}</span><span><strong>{item.counterparty || '—'}</strong></span><span>{item.cost_category || '—'}</span><span>{item.document_number || '—'}</span><span>{shortDate(item.planned_payment_date)}</span><span><i/>{item.urgency || 'Обычная'}</span><span>{money(item.amount)}</span></div>)}</section>
    <PaymentPrintReport data={data} filters={filters}/>
  </div>
}

function PaymentPrintReport({ data, filters }) {
  const generated = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return <article className="payment-print-report">
    <header className="payment-print-title"><div><p>ФинРеестр · платёжный документ</p><h1>Реестр платежей к оплате</h1><span>Сформирован {generated}</span></div><div className="payment-print-mark"><strong>К ОПЛАТЕ</strong><span>Внутренний документ</span></div></header>
    <section className="payment-print-filters"><div><span>Дата утверждения</span><strong>{filters.approval_date ? shortDate(filters.approval_date) : 'Все даты'}</strong></div><div><span>Юридическое лицо</span><strong>{filters.legal_entity || 'Все юридические лица'}</strong></div><div><span>Признак учёта</span><strong>{filters.account_type || 'Все значения'}</strong></div></section>
    <section className="payment-print-totals"><div><span>Количество платежей</span><strong>{data.count.toLocaleString('ru-RU')}</strong></div><div><span>Общая сумма</span><strong>{money(data.amount)}</strong></div></section>
    <table>
      <thead><tr><th>№</th><th>Признак учёта</th><th>Юридическое лицо</th><th>Контрагент</th><th>Статья затрат</th><th>Документ</th><th>Срок оплаты</th><th>Срочность</th><th>Сумма</th></tr></thead>
      <tbody>{data.items.length ? data.items.map((item, index) => <tr key={item.id} className={item.urgency === 'Критическая' ? 'critical' : ''}><td>{index + 1}</td><td>{item.account_type || '—'}</td><td>{item.legal_entity || '—'}</td><td>{item.counterparty || '—'}</td><td>{item.cost_category || '—'}</td><td>{item.document_number || '—'}</td><td>{shortDate(item.planned_payment_date)}</td><td>{item.urgency || 'Обычная'}</td><td>{money(item.amount)}</td></tr>) : <tr><td colSpan="9" className="payment-print-empty">По выбранным условиям платежей нет</td></tr>}</tbody>
      <tfoot><tr><td colSpan="7"/><td>Итого</td><td>{money(data.amount)}</td></tr></tfoot>
    </table>
    <footer className="payment-print-signatures"><div><span>Подготовил</span><i/><small>подпись / Ф.И.О.</small></div><div><span>Согласовал</span><i/><small>подпись / Ф.И.О.</small></div><div><span>Дата</span><i/><small>дд / мм / гггг</small></div></footer>
  </article>
}
