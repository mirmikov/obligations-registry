import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronDown, Download, ExternalLink, Printer, RefreshCw } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { DuplicateObligationModal, InlineCellSelect, normalizeCellValue, ObligationHistoryModal, ObligationScanControl, sameCellValue, stripObligation } from './Registry'
import { localTodayISO, paymentColumns, paymentRowClassName, paymentScreenColumns } from './paymentsView'
import { approvalStatusOptions, can, canApproveObligations } from './permissions'
import { withDerivedObligationValues } from './obligationValues'
import { buildCostCategoryResponsibleMap, withDefaultResponsible } from './referenceDefaults'
import './paymentsPaid.css'

export default function Payments({ user, notify }) {
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(() => ({ approval_date: localTodayISO(), legal_entity: '', account_type: '' }))
  const [data, setData] = useState({ items: [], count: 0, amount: 0 })
  const [loading, setLoading] = useState(true)
  const [savingCells, setSavingCells] = useState(new Set())
  const [detailItem, setDetailItem] = useState(null)
  const [duplicatePrompt, setDuplicatePrompt] = useState(null)
  const rowsRef = useRef(new Map())
  const saveQueues = useRef(new Map())
  const responsibleByCostCategory = useMemo(() => buildCostCategoryResponsibleMap(refs), [refs])
  const query = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([,v]) => v))).toString()
  const load = () => { setLoading(true); return request(`/api/payment-register?${query}`).then(result => { rowsRef.current = new Map(result.items.map(item => [item.id, item])); setData(result) }).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  const markSaving = (key, active) => setSavingCells(current => { const next = new Set(current); active ? next.add(key) : next.delete(key); return next })
  const confirmDuplicate = error => new Promise(resolve => setDuplicatePrompt({ ...(error.details || {}), resolve }))
  const finishDuplicatePrompt = confirmed => {
    const resolve = duplicatePrompt?.resolve
    setDuplicatePrompt(null)
    resolve?.(confirmed)
  }
  const saveWithDuplicateConfirmation = async (id, values) => {
    try {
      return await request(`/api/payment-register/${id}`, { method: 'PATCH', body: JSON.stringify(values) })
    } catch (error) {
      if (error.code !== 'duplicate_obligation') throw error
      if (!await confirmDuplicate(error)) {
        const canceled = new Error('Сохранение дубликата отменено')
        canceled.duplicateCanceled = true
        throw canceled
      }
      return request(`/api/payment-register/${id}`, { method: 'PATCH', body: JSON.stringify({ ...values, allow_duplicate: true }) })
    }
  }
  const saveField = async (item, field, rawValue) => {
    let value
    try { value = normalizeCellValue(field, rawValue) } catch (error) { notify(error.message, 'error'); return false }
    const current = rowsRef.current.get(item.id) || item
    if (sameCellValue(current[field], value)) return true
    const next = withDefaultResponsible(withDerivedObligationValues({ ...current, [field]: value }, field), field, responsibleByCostCategory)
    rowsRef.current.set(item.id, next)
    setData(state => {
      const items = state.items.map(row => row.id === item.id ? next : row)
      return { ...state, items, amount: items.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) }
    })
    const cellKey = `${item.id}:${field}`
    markSaving(cellKey, true)
    const previousSave = saveQueues.current.get(item.id) || Promise.resolve()
    const operation = previousSave.catch(() => {}).then(() => saveWithDuplicateConfirmation(item.id, stripObligation(rowsRef.current.get(item.id))))
    saveQueues.current.set(item.id, operation)
    try {
      await operation
      notify(`${paymentScreenColumns.find(column => column.key === field)?.label || 'Поле'} обновлено`)
      if (next.status !== current.status || ['approval_date', 'legal_entity', 'account_type'].includes(field)) await load()
      return true
    } catch (error) {
      const latest = rowsRef.current.get(item.id)
      if (sameCellValue(latest?.[field], value)) {
        rowsRef.current.set(item.id, current)
        setData(state => {
          const items = state.items.map(row => row.id === item.id ? current : row)
          return { ...state, items, amount: items.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) }
        })
      }
      if (!error.duplicateCanceled) notify(error.message, 'error')
      return false
    } finally {
      markSaving(cellKey, false)
    }
  }
  useEffect(() => { request('/api/references').then(setRefs).catch(e => notify(e.message,'error')) }, [])
  useEffect(() => { load() }, [query])
  const approvalEditable = canApproveObligations(user)
  return <div className="page payments-page">
    <PageHeader eyebrow="Платёжный реестр" title="Обязательства к оплате" subtitle="Согласованные платежи по выбранным условиям" actions={<><button className="secondary" onClick={load}><RefreshCw size={17}/>Обновить</button>{can(user, 'payments.print') && <button className="secondary" onClick={() => window.print()} disabled={loading}><Printer size={17}/>Печать</button>}{can(user, 'registry.export') && <button className="primary" onClick={() => download(`/api/obligations/export.xlsx?status=${encodeURIComponent('К оплате')}&${query}`, 'К оплате.xlsx')}><Download size={17}/>Выгрузить</button>}</>}/>
    <section className="payment-toolbar"><label><span>Дата утверждения</span><DateInput value={filters.approval_date} onChange={value => setFilters({...filters,approval_date:value})} aria-label="Дата утверждения"/></label><label><span>Юридическое лицо</span><select value={filters.legal_entity} onChange={e => setFilters({...filters,legal_entity:e.target.value})}><option value="">Все юрлица</option>{(refs.legal_entities||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label><label><span>Признак учёта</span><select value={filters.account_type} onChange={e => setFilters({...filters,account_type:e.target.value})}><option value="">Все</option>{(refs.account_types||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label></section>
    <section className="payment-summary"><div><CalendarDays/><span>Количество платежей<strong>{data.count}</strong></span></div><div><span>Общая сумма<strong>{money(data.amount)}</strong></span></div></section>
    <section className="payment-list panel"><div className="payment-head">{paymentScreenColumns.map(column => <span key={column.key}>{column.label}</span>)}</div>{loading ? <div className="loading-line"/> : data.items.length === 0 ? <div className="empty-state"><CalendarDays size={28}/><strong>По выбранным условиям платежей нет</strong><span>Выберите другую дату или юридическое лицо</span></div> : data.items.map(item => <PaymentRow key={item.id} item={item} refs={refs} editable={can(user, 'payments.edit')} approvalEditable={approvalEditable} savingCells={savingCells} onSave={saveField} onOpenDetails={() => setDetailItem(item)} notify={notify}/>)}</section>
    <PaymentPrintReport data={data} filters={filters}/>
    {detailItem && <ObligationHistoryModal item={detailItem} notify={notify} onClose={() => setDetailItem(null)}/>}
    {duplicatePrompt && <DuplicateObligationModal conflict={duplicatePrompt} onCancel={() => finishDuplicatePrompt(false)} onConfirm={() => finishDuplicatePrompt(true)}/>}
  </div>
}

function PaymentRow({ item, refs, editable, approvalEditable, savingCells, onSave, onOpenDetails, notify }) {
  return <div className={paymentRowClassName(item)}>
    {paymentScreenColumns.map(column => <span key={column.key} className="payment-interactive-cell">
      <PaymentEditableCell item={item} column={column} refs={refs} editable={editable} approvalEditable={approvalEditable} saving={savingCells.has(`${item.id}:${column.key}`)} onSave={onSave}/>
    </span>)}
    <div className="payment-row-actions">
      {item.has_scan && <span className="payment-scan-control"><ObligationScanControl item={item} editable={false} notify={notify} onChanged={() => {}} scanURL={`/api/payment-register/${item.id}/scan`}/></span>}
      <button type="button" className="payment-details-button" onClick={onOpenDetails} title="Подробнее о платеже" aria-label={`Подробнее о платеже №${item.id}`}><ExternalLink size={17}/></button>
    </div>
  </div>
}

function PaymentEditableCell({ item, column, refs, editable, approvalEditable, saving, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const options = paymentCellOptions(refs, column.key, approvalEditable)
  const type = paymentCellType(column.key)
  const begin = () => {
    if (!editable || saving) return
    setDraft(item[column.key] == null ? '' : String(item[column.key]))
    setEditing(true)
  }
  const commit = async rawValue => {
    const ok = await onSave(item, column.key, rawValue)
    if (ok) setEditing(false)
  }
  const keyDown = event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
  }
  if (editing && options) return <InlineCellSelect label={column.label} value={item[column.key] || ''} options={options} allowCustom={column.key === 'counterparty'} onChoose={commit} onCancel={() => setEditing(false)}/>
  if (editing && type === 'date') return <div className={`payment-cell-date ${saving ? 'is-saving' : ''}`}><DateInput value={item[column.key] || ''} onChange={commit} onClose={() => setEditing(false)} aria-label={`${column.label}, запись №${item.id}`} autoFocus/></div>
  if (editing) return <input className={`payment-cell-input ${column.key === 'amount' ? 'is-money' : ''}`} type={type} value={draft} onChange={event => setDraft(event.target.value)} onBlur={event => commit(event.target.value)} onKeyDown={keyDown} autoFocus/>
  return <button type="button" className={`payment-cell-control ${column.key === 'amount' ? 'is-money' : ''}`} onClick={begin} disabled={!editable || saving} aria-label={`${column.label}: ${paymentValue(item, column.key)}`}>
    <span>{saving ? 'Сохраняем…' : paymentValue(item, column.key)}</span>{editable && options && <ChevronDown size={14}/>}
  </button>
}

function paymentCellType(key) {
  if (key === 'document_date' || key === 'actual_payment_date') return 'date'
  if (key === 'amount') return 'number'
  return 'text'
}

function paymentCellOptions(refs, key, approvalEditable) {
  if (key === 'status') return approvalStatusOptions(refs.statuses, approvalEditable)
  return ({ account_type: refs.account_types, legal_entity: refs.legal_entities, counterparty: refs.counterparties }[key] || null)
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
  if (key === 'planned_payment_date' || key === 'document_date' || key === 'actual_payment_date') return shortDate(item[key])
  if (key === 'amount') return money(item[key])
  return item[key] || '—'
}
