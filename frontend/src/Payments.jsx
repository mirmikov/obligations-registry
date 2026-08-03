import { useEffect, useState } from 'react'
import { CalendarDays, ChevronDown, Download, ExternalLink, Printer, RefreshCw } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { InlineCellSelect, ObligationHistoryModal } from './Registry'
import { localTodayISO, paymentColumns, paymentScreenColumns, paymentUpdatePayload } from './paymentsView'
import { can } from './permissions'

export default function Payments({ user, notify }) {
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(() => ({ approval_date: localTodayISO(), legal_entity: '', account_type: '' }))
  const [data, setData] = useState({ items: [], count: 0, amount: 0 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [detailItem, setDetailItem] = useState(null)
  const query = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([,v]) => v))).toString()
  const load = () => { setLoading(true); return request(`/api/payment-register?${query}`).then(setData).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  const saveField = async (item, field, value) => {
    const key = `${item.id}:${field}`
    setSaving(key)
    try {
      const updated = paymentUpdatePayload(item, field, value)
      await request(`/api/payment-register/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: updated.status || '', actual_payment_date: updated.actual_payment_date || '' }) })
      notify(field === 'status' ? 'Статус обновлён' : 'Фактическая дата оплаты обновлена')
      await load()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSaving('')
    }
  }
  useEffect(() => { request('/api/references').then(setRefs).catch(e => notify(e.message,'error')) }, [])
  useEffect(() => { load() }, [query])
  return <div className="page payments-page">
    <PageHeader eyebrow="Платёжный реестр" title="Обязательства к оплате" subtitle="Согласованные платежи по выбранным условиям" actions={<><button className="secondary" onClick={load}><RefreshCw size={17}/>Обновить</button>{can(user, 'payments.print') && <button className="secondary" onClick={() => window.print()} disabled={loading}><Printer size={17}/>Печать</button>}{can(user, 'registry.export') && <button className="primary" onClick={() => download(`/api/obligations/export.xlsx?status=${encodeURIComponent('К оплате')}&${query}`, 'К оплате.xlsx')}><Download size={17}/>Выгрузить</button>}</>}/>
    <section className="payment-toolbar"><label><span>Дата утверждения</span><DateInput value={filters.approval_date} onChange={value => setFilters({...filters,approval_date:value})} aria-label="Дата утверждения"/></label><label><span>Юридическое лицо</span><select value={filters.legal_entity} onChange={e => setFilters({...filters,legal_entity:e.target.value})}><option value="">Все юрлица</option>{(refs.legal_entities||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label><label><span>Признак учёта</span><select value={filters.account_type} onChange={e => setFilters({...filters,account_type:e.target.value})}><option value="">Все</option>{(refs.account_types||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label></section>
    <section className="payment-summary"><div><CalendarDays/><span>Количество платежей<strong>{data.count}</strong></span></div><div><span>Общая сумма<strong>{money(data.amount)}</strong></span></div></section>
    <section className="payment-list panel"><div className="payment-head">{paymentScreenColumns.map(column => <span key={column.key}>{column.label}</span>)}</div>{loading ? <div className="loading-line"/> : data.items.length === 0 ? <div className="empty-state"><CalendarDays size={28}/><strong>По выбранным условиям платежей нет</strong><span>Выберите другую дату или юридическое лицо</span></div> : data.items.map(item => <PaymentRow key={item.id} item={item} statuses={refs.statuses || []} editable={can(user, 'payments.edit')} saving={saving} onSave={saveField} onOpenDetails={() => setDetailItem(item)}/>)}</section>
    <PaymentPrintReport data={data} filters={filters}/>
    {detailItem && <ObligationHistoryModal item={detailItem} notify={notify} onClose={() => setDetailItem(null)}/>}
  </div>
}

function PaymentRow({ item, statuses, editable, saving, onSave, onOpenDetails }) {
  return <div className={`payment-row ${item.urgency === 'Критическая' ? 'critical' : ''}`}>
    {paymentScreenColumns.map(column => <span key={column.key} className={column.interactive ? 'payment-interactive-cell' : ''}>
      {column.key === 'status' ? <PaymentStatusCell item={item} statuses={statuses} editable={editable} saving={saving === `${item.id}:status`} onSave={onSave}/>
        : column.key === 'actual_payment_date' ? <PaymentActualDateCell item={item} editable={editable} saving={saving === `${item.id}:actual_payment_date`} onSave={onSave}/>
          : column.key === 'counterparty' ? <strong>{paymentValue(item, column.key)}</strong> : paymentValue(item, column.key)}
    </span>)}
    <button type="button" className="payment-details-button" onClick={onOpenDetails} title="Подробнее о платеже" aria-label={`Подробнее о платеже №${item.id}`}><ExternalLink size={17}/></button>
  </div>
}

function PaymentStatusCell({ item, statuses, editable, saving, onSave }) {
  const [open, setOpen] = useState(false)
  if (open && editable && !saving) return <InlineCellSelect label="Статус" value={item.status || ''} options={statuses} onChoose={value => { setOpen(false); onSave(item, 'status', value) }} onCancel={() => setOpen(false)}/>
  return <button type="button" className="payment-status-control" onClick={() => editable && setOpen(true)} disabled={!editable || saving} aria-label={`Статус: ${item.status || 'не выбран'}`} aria-expanded={open}>
    <span>{saving ? 'Сохраняем…' : item.status || 'Не выбран'}</span>{editable && <ChevronDown size={15}/>}
  </button>
}

function PaymentActualDateCell({ item, editable, saving, onSave }) {
  if (!editable) return <span className="payment-readonly-date">{shortDate(item.actual_payment_date)}</span>
  return <div className={`payment-actual-date-control ${saving ? 'is-saving' : ''}`}>
    <DateInput value={item.actual_payment_date || ''} onChange={value => onSave(item, 'actual_payment_date', value)} disabled={saving} aria-label={`Фактическая дата оплаты, запись №${item.id}`}/>
  </div>
}

function PaymentPrintReport({ data, filters }) {
  const generated = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return <article className="payment-print-report">
    <header className="payment-print-title"><div><p>ФинРеестр · платёжный документ</p><h1>Реестр платежей к оплате</h1><span>Сформирован {generated}</span></div><div className="payment-print-mark"><strong>К ОПЛАТЕ</strong><span>Внутренний документ</span></div></header>
    <section className="payment-print-filters"><div><span>Дата утверждения</span><strong>{filters.approval_date ? shortDate(filters.approval_date) : 'Все даты'}</strong></div><div><span>Юридическое лицо</span><strong>{filters.legal_entity || 'Все юридические лица'}</strong></div><div><span>Признак учёта</span><strong>{filters.account_type || 'Все значения'}</strong></div></section>
    <section className="payment-print-totals"><div><span>Количество платежей</span><strong>{data.count.toLocaleString('ru-RU')}</strong></div><div><span>Общая сумма</span><strong>{money(data.amount)}</strong></div></section>
    <table>
      <thead><tr><th>№</th>{paymentColumns.map(column => <th key={column.key}>{column.printLabel || column.label}</th>)}</tr></thead>
      <tbody>{data.items.length ? data.items.map((item, index) => <tr key={item.id} className={item.urgency === 'Критическая' ? 'critical' : ''}><td>{index + 1}</td>{paymentColumns.map(column => <td key={column.key}>{paymentValue(item, column.key)}</td>)}</tr>) : <tr><td colSpan={paymentColumns.length + 1} className="payment-print-empty">По выбранным условиям платежей нет</td></tr>}</tbody>
      <tfoot><tr><td colSpan="5"/><td>Итого</td><td>{money(data.amount)}</td></tr></tfoot>
    </table>
    <footer className="payment-print-signatures"><div><span>Подготовил</span><i/><small>подпись / Ф.И.О.</small></div><div><span>Согласовал</span><i/><small>подпись / Ф.И.О.</small></div><div><span>Дата</span><i/><small>дд / мм / гггг</small></div></footer>
  </article>
}

function paymentValue(item, key) {
  if (key === 'planned_payment_date' || key === 'document_date') return shortDate(item[key])
  if (key === 'amount') return money(item[key])
  return item[key] || '—'
}
