import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Download, Printer, RefreshCw } from 'lucide-react'
import { download, request } from './api'
import { DateInput, money, PageHeader, shortDate } from './App'
import { DuplicateObligationModal, normalizeCellValue, ObligationHistoryModal, RegistryRow, sameCellValue, stripObligation } from './Registry'
import { localTodayISO, paymentColumns, paymentEditableColumns } from './paymentsView'
import { can } from './permissions'
import { withDerivedObligationValues } from './obligationValues'
import { buildCostCategoryResponsibleMap, withDefaultResponsible } from './referenceDefaults'

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
      notify(`${paymentEditableColumns.find(column => column.key === field)?.label || 'Поле'} обновлено`)
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
  const tableWidth = 58 + paymentEditableColumns.reduce((sum, column) => sum + column.width, 0) + 118
  return <div className="page payments-page">
    <PageHeader eyebrow="Платёжный реестр" title="Обязательства к оплате" subtitle="Согласованные платежи по выбранным условиям" actions={<><button className="secondary" onClick={load}><RefreshCw size={17}/>Обновить</button>{can(user, 'payments.print') && <button className="secondary" onClick={() => window.print()} disabled={loading}><Printer size={17}/>Печать</button>}{can(user, 'registry.export') && <button className="primary" onClick={() => download(`/api/obligations/export.xlsx?status=${encodeURIComponent('К оплате')}&${query}`, 'К оплате.xlsx')}><Download size={17}/>Выгрузить</button>}</>}/>
    <section className="payment-toolbar"><label><span>Дата утверждения</span><DateInput value={filters.approval_date} onChange={value => setFilters({...filters,approval_date:value})} aria-label="Дата утверждения"/></label><label><span>Юридическое лицо</span><select value={filters.legal_entity} onChange={e => setFilters({...filters,legal_entity:e.target.value})}><option value="">Все юрлица</option>{(refs.legal_entities||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label><label><span>Признак учёта</span><select value={filters.account_type} onChange={e => setFilters({...filters,account_type:e.target.value})}><option value="">Все</option>{(refs.account_types||[]).map(x=><option key={x.id} value={x.value}>{x.value}</option>)}</select></label></section>
    <section className="payment-summary"><div><CalendarDays/><span>Количество платежей<strong>{data.count}</strong></span></div><div><span>Общая сумма<strong>{money(data.amount)}</strong></span></div></section>
    <section className="payment-list panel payment-editable-list"><div className="payment-edit-table-wrap"><table className="registry-table inline-registry payment-edit-table" style={{ '--registry-table-width': `${tableWidth}px`, '--registry-counterparty-left': '58px', '--registry-entry-date-left': '278px' }}><colgroup><col style={{ width: 58 }}/>{paymentEditableColumns.map(column => <col key={column.key} style={{ width: column.width }}/>)}<col style={{ width: 118 }}/></colgroup><thead><tr><th className="check-col" aria-label="Документ"/>{paymentEditableColumns.map(column => <th key={column.key} className={column.key === 'counterparty' ? 'counterparty-head' : column.key === 'entry_date' ? 'entry-date-head' : ''}><span className="column-label">{column.label}</span></th>)}<th className="action-col"/></tr></thead><tbody>{loading ? <PaymentSkeletonRows/> : data.items.length === 0 ? <tr><td colSpan={paymentEditableColumns.length + 2}><div className="empty-state"><CalendarDays size={28}/><strong>По выбранным условиям платежей нет</strong><span>Выберите другую дату или юридическое лицо</span></div></td></tr> : data.items.map(item => <RegistryRow key={item.id} item={item} refs={refs} editable={can(user, 'payments.edit')} savingCells={savingCells} onCommit={saveField} onStartEdit={() => {}} onFinishEdit={() => {}} showSelection={false} scanEditable={false} scanURL={`/api/payment-register/${item.id}/scan`} onScanChanged={() => {}} notify={notify} onInfo={() => setDetailItem(item)}/>)}</tbody></table></div></section>
    <PaymentPrintReport data={data} filters={filters}/>
    {detailItem && <ObligationHistoryModal item={detailItem} notify={notify} onClose={() => setDetailItem(null)}/>}
    {duplicatePrompt && <DuplicateObligationModal conflict={duplicatePrompt} onCancel={() => finishDuplicatePrompt(false)} onConfirm={() => finishDuplicatePrompt(true)}/>}
  </div>
}

function PaymentSkeletonRows() {
  return <>{Array.from({ length: 6 }).map((_, row) => <tr className="skeleton-row" key={row}>{Array.from({ length: paymentEditableColumns.length + 2 }).map((__, column) => <td key={column}><i/></td>)}</tr>)}</>
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
