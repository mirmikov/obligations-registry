import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, FileText, FileUp, Filter, History, Info, LoaderCircle, LocateFixed, Maximize2, Megaphone, Minimize2, Paperclip, Plus, RotateCcw, ScanLine, Scissors, Search, Trash2, UserRound, X } from 'lucide-react'
import { download, request, requestBlob } from './api'
import { DateInput, money, PageHeader, roleLabel, shortDate } from './App'
import { BLANK_ACCOUNT_TYPE_FILTER } from './filterValues'
import { withDerivedObligationValues } from './obligationValues'
import { mergeCurrentObligationRecord } from './obligationHistoryView'
import { getRegistryStickyOffsets } from './registryColumns'
import { canContinueRegistryDrag, canStartRegistryDrag, getRegistryDragScroll, hasRegistryDragStarted } from './registryDragScroll'
import { approvalStatusOptions, can, canApproveObligations } from './permissions'
import { referenceOptionSearchText } from './counterpartyTaxId'
import { counterpartyCreationSeed, normalizedCounterpartyOptions } from './counterpartyCreation'
import { buildCostCategoryResponsibleMap, buildCounterpartyDefermentMap, withReferenceDefaults } from './referenceDefaults'
import { buildAdvancedSplitPreview, createAdvancedSplitFields, isAdvancedSplitMode } from './advancedPaymentSplit'
import { buildPaymentSplitPayload } from './paymentSplitPayload'
import AdvancedSplitEditor, { AdvancedSplitModePicker } from './AdvancedSplitEditor'
import usePresence from './usePresence'
import AIScanModal from './AIScanModal'
import { CounterpartyModal } from './References'
import DesktopBroadcastModal from './DesktopBroadcastModal'

const emptyFilters = { q: '', amount: '', counterparty: [], account_type: '', legal_entity: '', cost_category: '', priority: '', responsible: '', status: '', urgency: '', entry_date: '', document_date: '', planned_payment_date: '', approval_date: '', actual_payment_date: '', document_from: '', document_to: '', overdue: '' }
const dateFields = new Set(['entry_date', 'document_date', 'planned_payment_date', 'approval_date', 'actual_payment_date'])
export const fieldLabels = { counterparty: 'Контрагент', entry_date: 'Дата внесения', document_number: 'Документ', document_date: 'Дата документа', legal_entity: 'Юрлицо', cost_category: 'Статья затрат', amount: 'Сумма, ₽', deferment_days: 'Отсрочка, дней', planned_payment_date: 'Плановая оплата', approval_date: 'Дата утверждения', actual_payment_date: 'Фактическая оплата', status: 'Статус', urgency: 'Срочность', responsible: 'Ответственный', priority: 'Приоритет', account_type: 'Признак учёта', comment: 'Комментарий', source_note: 'Условия оплаты' }
const historyFieldLabels = { ...fieldLabels, split_group_id: 'Группа платежей', split_parent_id: 'Исходный платёж', installment_number: 'Номер платежа', installment_count: 'Количество платежей' }
const historyActionLabels = { create: 'Запись создана', update: 'Запись изменена', bulk_update: 'Массовое изменение', split: 'Платёж разбит', delete: 'Запись удалена' }
const historyCurrentFields = [
  ['account_type', 'Признак учёта'], ['legal_entity', 'Юридическое лицо'], ['counterparty', 'Контрагент'], ['document_number', 'Документ'],
  ['document_date', 'Дата документа'], ['cost_category', 'Статья затрат'], ['amount', 'Сумма'], ['planned_payment_date', 'Плановая дата оплаты'],
  ['approval_date', 'Дата утверждения'], ['actual_payment_date', 'Фактическая дата оплаты'], ['status', 'Статус'], ['urgency', 'Срочность'],
  ['responsible', 'Ответственный'], ['priority', 'Приоритет'], ['comment', 'Комментарий'], ['source_note', 'Условия оплаты'],
]
const defaultRegistryColumnWidths = [58, 220, 130, 130, 180, 120, 180, 135, 240, 110, 145, 145, 145, 160, 135, 160, 120, 240, 240, 118]
const minimumRegistryColumnWidths = [58, 130, 105, 100, 120, 90, 110, 110, 130, 90, 115, 115, 115, 110, 105, 115, 95, 120, 120, 108]
const registryColumnWidthsKey = 'registry-table-column-widths-v1'
const registryLargeFontKey = 'registry-table-large-font'
const registryDragIgnoredSelector = 'button, input, select, textarea, a, label, [contenteditable="true"], [role="button"], [role="separator"], .inline-select-menu, .date-input-wrap'

function readLargeFontPreference() {
  try { return window.localStorage.getItem(registryLargeFontKey) === 'true' } catch { return false }
}

function normalizeColumnWidth(value, index) {
  const width = Number(value)
  return Number.isFinite(width) ? Math.min(600, Math.max(minimumRegistryColumnWidths[index], Math.round(width))) : defaultRegistryColumnWidths[index]
}

function readColumnWidths() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(registryColumnWidthsKey))
    if (Array.isArray(saved) && saved.length === defaultRegistryColumnWidths.length) return saved.map(normalizeColumnWidth)
  } catch {}
  return [...defaultRegistryColumnWidths]
}

function saveColumnWidths(widths) {
  try { window.localStorage.setItem(registryColumnWidthsKey, JSON.stringify(widths)) } catch {}
}

export default function Registry({ user, notify, maintenance, onToggleMaintenance, initialAIScanBatch, onInitialAIScanApplied }) {
  const [data, setData] = useState({ items: [], total: 0, filtered_amount: 0, page: 1, page_size: 50 })
  const [refs, setRefs] = useState({})
  const [filters, setFilters] = useState(emptyFilters)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState({ key: 'updated_at', order: 'desc' })
  const [loading, setLoading] = useState(true)
  const [newRow, setNewRow] = useState(null)
  const [savingCells, setSavingCells] = useState(new Set())
  const [selected, setSelected] = useState([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [splitItem, setSplitItem] = useState(null)
  const [historyItem, setHistoryItem] = useState(null)
  const [aiScan, setAIScan] = useState(null)
  const [duplicatePrompt, setDuplicatePrompt] = useState(null)
  const [counterpartyModal, setCounterpartyModal] = useState(null)
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [tableFullscreen, setTableFullscreen] = useState(false)
  const [largeTableFont, setLargeTableFont] = useState(readLargeFontPreference)
  const [columnWidths, setColumnWidths] = useState(readColumnWidths)
  const [viewReady, setViewReady] = useState(false)
  const importRef = useRef()
  const aiScanRef = useRef()
  const initialAIScanRef = useRef(null)
  const tableWrapRef = useRef()
  const rowsRef = useRef(new Map())
  const saveQueues = useRef(new Map())
  const creatingRef = useRef(false)
  const scrollPositionRef = useRef({ left: 0, top: 0 })
  const scrollSaveTimerRef = useRef()
  const latestViewRef = useRef(null)
  const columnWidthsRef = useRef(columnWidths)
  const resizeCleanupRef = useRef(null)
  const tableDragRef = useRef(null)
  const suppressTableClickRef = useRef(false)
  const { activeUsers, updateLocation, sessionId } = usePresence({ page: 'registry', page_label: 'Реестр обязательств', mode: 'view' })
  columnWidthsRef.current = columnWidths

  useEffect(() => {
    Promise.all([request('/api/references'), request('/api/saved-view')]).then(([references, saved]) => {
      const view = normalizeSavedView(saved)
      setRefs(references); setFilters(view.filters); setPage(view.page); setSort(view.sort); setTableFullscreen(view.fullscreen)
      scrollPositionRef.current = { left: view.scroll_left, top: view.scroll_top }
    }).catch(error => notify(error.message, 'error')).finally(() => setViewReady(true))
  }, [])
  const query = useMemo(() => {
    const params = new URLSearchParams({ page, page_size: 50, sort: sort.key, order: sort.order })
    Object.entries(filters).forEach(([key, value]) => {
      if (Array.isArray(value)) value.filter(Boolean).forEach(item => params.append(key, item))
      else if (value) params.set(key, value)
    })
    return params.toString()
  }, [filters, page, sort])
  const load = () => { setLoading(true); request(`/api/obligations?${query}`).then(result => { const lastPage = Math.max(1, Math.ceil(result.total / result.page_size)); if (page > lastPage) { setPage(lastPage); return }; rowsRef.current = new Map(result.items.map(item => [item.id, item])); setData(result) }).catch(e => notify(e.message, 'error')).finally(() => setLoading(false)) }
  const updateScanMeta = (id, meta) => {
    const scanValues = meta ? { has_scan: true, scan_name: meta.name, scan_size: meta.size, scan_updated_at: meta.updated_at } : { has_scan: false, scan_name: '', scan_size: 0, scan_updated_at: '' }
    setData(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, ...scanValues } : item) }))
    const current = rowsRef.current.get(id)
    if (current) rowsRef.current.set(id, { ...current, ...scanValues })
  }
  useEffect(() => { if (!viewReady) return; const timer = setTimeout(load, 220); return () => clearTimeout(timer) }, [query, viewReady])
  const viewPayload = () => ({ filters, page, sort, scroll_left: scrollPositionRef.current.left, scroll_top: scrollPositionRef.current.top, fullscreen: tableFullscreen })
  latestViewRef.current = viewReady ? viewPayload() : null
  useEffect(() => {
    if (!viewReady) return
    const timer = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(viewPayload()) }).catch(() => {}), 300)
    return () => clearTimeout(timer)
  }, [filters, page, sort, tableFullscreen, viewReady])
  useEffect(() => {
    const flushView = () => {
      clearTimeout(scrollSaveTimerRef.current)
      if (latestViewRef.current) request('/api/saved-view', { method: 'PUT', body: JSON.stringify(latestViewRef.current), keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', flushView)
    return () => { window.removeEventListener('pagehide', flushView); flushView() }
  }, [])
  useEffect(() => {
    if (!viewReady || loading) return
    const frame = requestAnimationFrame(() => tableWrapRef.current?.scrollTo(scrollPositionRef.current))
    return () => cancelAnimationFrame(frame)
  }, [viewReady, loading, data.items.length])
  useEffect(() => {
    if (!tableFullscreen) return
    const exitFullscreen = event => { if (event.key === 'Escape' && !event.defaultPrevented) setTableFullscreen(false) }
    document.addEventListener('keydown', exitFullscreen)
    return () => document.removeEventListener('keydown', exitFullscreen)
  }, [tableFullscreen])
  useEffect(() => {
    try { window.localStorage.setItem(registryLargeFontKey, String(largeTableFont)) } catch {}
  }, [largeTableFont])
  useEffect(() => () => resizeCleanupRef.current?.(), [])
  const tableWidth = useMemo(() => columnWidths.reduce((sum, width) => sum + width, 0), [columnWidths])
  const responsibleByCostCategory = useMemo(() => buildCostCategoryResponsibleMap(refs), [refs])
  const defermentByCounterparty = useMemo(() => buildCounterpartyDefermentMap(refs), [refs])
  const stickyOffsets = useMemo(() => getRegistryStickyOffsets(columnWidths), [columnWidths])
  const setColumnWidth = (index, width, persist = true) => {
    const next = [...columnWidthsRef.current]
    next[index] = normalizeColumnWidth(width, index)
    columnWidthsRef.current = next
    setColumnWidths(next)
    if (persist) saveColumnWidths(next)
  }
  const startColumnResize = (index, event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resizeCleanupRef.current?.()
    const startX = event.clientX
    const startWidth = columnWidthsRef.current[index]
    const move = moveEvent => {
      moveEvent.preventDefault()
      setColumnWidth(index, startWidth + moveEvent.clientX - startX, false)
    }
    const finish = () => {
      saveColumnWidths(columnWidthsRef.current)
      document.body.classList.remove('registry-column-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      resizeCleanupRef.current = null
    }
    resizeCleanupRef.current = finish
    document.body.classList.add('registry-column-resizing')
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const resizeColumnBy = (index, delta) => setColumnWidth(index, columnWidthsRef.current[index] + delta)
  const resetColumnWidth = index => setColumnWidth(index, defaultRegistryColumnWidths[index])
  const resetColumnWidths = () => {
    const defaults = [...defaultRegistryColumnWidths]
    columnWidthsRef.current = defaults
    setColumnWidths(defaults)
    saveColumnWidths(defaults)
  }
  const resizeProps = index => ({ columnIndex: index, columnWidth: columnWidths[index], onResizeStart: startColumnResize, onResizeBy: resizeColumnBy, onResizeReset: resetColumnWidth })
  const setFilter = (key, value) => { setFilters(old => ({ ...old, [key]: value })); setPage(1) }
  const rememberScroll = event => {
    scrollPositionRef.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
    if (latestViewRef.current) latestViewRef.current = { ...latestViewRef.current, scroll_left: scrollPositionRef.current.left, scroll_top: scrollPositionRef.current.top }
    clearTimeout(scrollSaveTimerRef.current)
    scrollSaveTimerRef.current = setTimeout(() => request('/api/saved-view', { method: 'PUT', body: JSON.stringify(viewPayload()) }).catch(() => {}), 350)
  }
  const startTableDrag = event => {
    if (!canStartRegistryDrag(event.button, event.isPrimary) || event.target.closest(registryDragIgnoredSelector)) return
    tableDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      dragging: false,
    }
  }
  const moveTableDrag = event => {
    const drag = tableDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !canContinueRegistryDrag(event.buttons)) return
    if (!drag.dragging && !hasRegistryDragStarted(drag.startX, drag.startY, event.clientX, event.clientY)) return
    if (!drag.dragging) {
      drag.dragging = true
      event.currentTarget.classList.add('is-drag-panning')
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const next = getRegistryDragScroll(drag.scrollLeft, drag.scrollTop, drag.startX, drag.startY, event.clientX, event.clientY)
    event.preventDefault()
    event.currentTarget.scrollLeft = next.left
    event.currentTarget.scrollTop = next.top
  }
  const finishTableDrag = event => {
    const drag = tableDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressTableClickRef.current = drag.dragging
    if (drag.dragging) window.setTimeout(() => { suppressTableClickRef.current = false }, 0)
    tableDragRef.current = null
    event.currentTarget.classList.remove('is-drag-panning')
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const suppressTableClick = event => {
    if (!suppressTableClickRef.current) return
    suppressTableClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const allSelected = data.items.length > 0 && data.items.every(item => selected.includes(item.id))
  const selectedItem = selected.length === 1 ? rowsRef.current.get(selected[0]) : null
  const toggleAll = () => setSelected(allSelected ? selected.filter(id => !data.items.some(i => i.id === id)) : [...new Set([...selected, ...data.items.map(i => i.id)])])
  const markSaving = (key, active) => setSavingCells(current => { const next = new Set(current); active ? next.add(key) : next.delete(key); return next })

  const confirmDuplicate = error => new Promise(resolve => {
    setDuplicatePrompt({ ...(error.details || {}), resolve })
  })
  const finishDuplicatePrompt = confirmed => {
    const resolve = duplicatePrompt?.resolve
    setDuplicatePrompt(null)
    resolve?.(confirmed)
  }
  const requestJSONWithDuplicateConfirmation = async (path, method, values) => {
    try {
      return await request(path, { method, body: JSON.stringify(values) })
    } catch (error) {
      if (error.code !== 'duplicate_obligation') throw error
      if (!await confirmDuplicate(error)) {
        const canceled = new Error('Сохранение дубликата отменено')
        canceled.duplicateCanceled = true
        throw canceled
      }
      return request(path, { method, body: JSON.stringify({ ...values, allow_duplicate: true }) })
    }
  }
  const startCellEdit = (item, field) => updateLocation({ mode: 'edit', record_id: item.id || 0, source_row: item.source_row || 0, field, field_label: fieldLabels[field] || field })
  const finishCellEdit = item => updateLocation({ mode: 'view', record_id: item.id || 0, source_row: item.source_row || 0, field: '', field_label: '' })
  const commitCell = async (item, field, rawValue) => {
    let value
    try { value = normalizeCellValue(field, rawValue) } catch (error) { notify(error.message, 'error'); return false }
    const current = rowsRef.current.get(item.id) || item
    if (sameCellValue(current[field], value)) { finishCellEdit(current); return true }
    const previousValue = current[field]
    const next = withReferenceDefaults({ ...current, [field]: value }, field, responsibleByCostCategory, defermentByCounterparty)
    rowsRef.current.set(item.id, next)
    setData(state => ({ ...state, items: state.items.map(row => row.id === item.id ? next : row) }))
    const cellKey = `${item.id}:${field}`
    markSaving(cellKey, true); finishCellEdit(next)
    const previousSave = saveQueues.current.get(item.id) || Promise.resolve()
    const operation = previousSave.catch(() => {}).then(() => requestJSONWithDuplicateConfirmation(`/api/obligations/${item.id}`, 'PATCH', stripObligation(rowsRef.current.get(item.id))))
    saveQueues.current.set(item.id, operation)
    try { await operation; return true } catch (error) {
      const latest = rowsRef.current.get(item.id)
      if (sameCellValue(latest?.[field], value)) {
        const reverted = { ...latest, [field]: previousValue }
        if (!sameCellValue(next.status, current.status) && sameCellValue(latest?.status, next.status)) reverted.status = current.status
        if (!sameCellValue(next.planned_payment_date, current.planned_payment_date) && sameCellValue(latest?.planned_payment_date, next.planned_payment_date)) reverted.planned_payment_date = current.planned_payment_date
        if (!sameCellValue(next.deferment_days, current.deferment_days) && sameCellValue(latest?.deferment_days, next.deferment_days)) reverted.deferment_days = current.deferment_days
        rowsRef.current.set(item.id, reverted)
        setData(state => ({ ...state, items: state.items.map(row => row.id === item.id ? reverted : row) }))
      }
      if (!error.duplicateCanceled) notify(error.message, 'error'); return false
    } finally { markSaving(cellKey, false) }
  }
  const addInlineRow = () => setNewRow(current => current ? null : blankObligation())
  const commitNewCell = async (item, field, rawValue) => {
    let value
    try { value = normalizeCellValue(field, rawValue) } catch (error) { notify(error.message, 'error'); return false }
    const next = withReferenceDefaults({ ...item, [field]: value }, field, responsibleByCostCategory, defermentByCounterparty)
    setNewRow(next)
    if (sameCellValue(item[field], value) || creatingRef.current) return true
    creatingRef.current = true; markSaving(`new:${field}`, true)
    try {
      const result = await requestJSONWithDuplicateConfirmation('/api/obligations', 'POST', stripObligation(next))
      const created = { ...next, id: result.id, source_row: 0, overdue: false, due_soon: false }
      rowsRef.current.set(created.id, created)
      setData(state => ({ ...state, items: [created, ...state.items].slice(0, state.page_size), total: state.total + 1 }))
      setNewRow(null); finishCellEdit(created); notify('Новая строка создана')
      return true
    } catch (error) { if (!error.duplicateCanceled) notify(error.message, 'error'); return false }
    finally { creatingRef.current = false; markSaving(`new:${field}`, false) }
  }
  const openCounterpartyModal = (item, enteredValue) => {
    const seed = counterpartyCreationSeed(enteredValue)
    finishCellEdit(item)
    setCounterpartyModal({ item, isNew: !item.id, ...seed })
  }
  const addCounterpartyFromRegistry = async (value, taxID) => {
    const target = counterpartyModal
    if (!target) return
    let created
    try {
      created = await request('/api/registry/counterparties', {
        method: 'POST', body: JSON.stringify({ value, tax_id: taxID, new_only: true }),
      })
      const references = await request('/api/references')
      setRefs(references)
    } catch (error) {
      notify(error.message, 'error')
      throw error
    }
    const saved = target.isNew
      ? await commitNewCell(target.item, 'counterparty', value)
      : await commitCell(target.item, 'counterparty', value)
    setCounterpartyModal(null)
    if (saved) notify(`Контрагент «${value}» добавлен и выбран`)
    else notify(`Контрагент «${created?.value || value}» добавлен в справочник. Выберите его в строке повторно`, 'error')
  }
  const remove = async id => { if (!confirm('Удалить обязательство? Отменить это действие нельзя.')) return; try { await request(`/api/obligations/${id}`, { method: 'DELETE' }); notify('Запись удалена'); load() } catch (e) { notify(e.message, 'error') } }
  const splitPayment = async (item, values) => {
    try {
      const result = await request(`/api/obligations/${item.id}/split`, { method: 'POST', body: JSON.stringify(values) })
      notify(`Платёж разбит на ${result.installments.length} ${partWord(result.installments.length)} без изменения общей суммы`)
      setSplitItem(null); setSelected([]); load()
    } catch (error) { notify(error.message, 'error'); throw error }
  }
  const importFile = async event => {
    const file = event.target.files?.[0]
    if (!file) return
    const send = allowDuplicate => { const body = new FormData(); body.append('file', file); if (allowDuplicate) body.append('allow_duplicate', 'true'); return request('/api/obligations/import.xlsx', { method: 'POST', body }) }
    try {
      let result
      try { result = await send(false) } catch (error) {
        if (error.code !== 'duplicate_obligation') throw error
        if (!await confirmDuplicate(error)) return
        result = await send(true)
      }
      notify(`База обновлена: ${result.updated} изменено, ${result.created} добавлено`); load(); request('/api/references').then(setRefs).catch(e => notify(e.message, 'error'))
    } catch (e) { notify(e.message, 'error') } finally { event.target.value = '' }
  }
  const finishAIScan = async (initialResult, fallbackFilename) => {
    let result = initialResult
    setAIScan({ ...result, loading: true, filename: result.original_name || fallbackFilename, error: '' })
    for (let attempt = 0; result.status === 'processing' && attempt < 360; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, 2000))
      result = await request(`/api/obligations/ai-scan/${result.batch}/status`)
    }
    if (result.status === 'processing') throw new Error('Распознавание не завершилось за 12 минут. Разделите PDF на части')
    if (result.status === 'error') throw new Error(result.error || 'Не удалось распознать документ')
    const items = result.items.map(item => ({
      page: item.page,
      include: !item.duplicate,
      duplicate: item.duplicate,
      duplicate_matches: item.duplicate_matches || [],
      warnings: item.warnings || [],
      confidence: item.confidence || {},
      values: withReferenceDefaults(
        { ...blankObligation(), status: '', counterparty: item.counterparty || '', legal_entity: item.legal_entity || '', document_number: item.document_number || '', document_date: item.document_date || '', amount: item.amount ?? null },
        'counterparty',
        responsibleByCostCategory,
        defermentByCounterparty,
      ),
    }))
    setAIScan({ ...result, filename: result.original_name || fallbackFilename, items, loading: false, error: '' })
  }
  useEffect(() => {
    if (!initialAIScanBatch || initialAIScanRef.current === initialAIScanBatch || !can(user, 'registry.ai_scan')) return
    initialAIScanRef.current = initialAIScanBatch
    onInitialAIScanApplied?.()
    setAIScan({ batch: initialAIScanBatch, loading: true, filename: 'Документ из Windows', error: '' })
    finishAIScan({ batch: initialAIScanBatch, status: 'processing' }, 'Документ из Windows').catch(error => {
      setAIScan({ batch: initialAIScanBatch, loading: false, filename: 'Документ из Windows', error: error.message })
    })
  }, [initialAIScanBatch, user?.id])
  const analyzeScan = async event => {
    const file = event.target.files?.[0]
    if (!file) return
    setAIScan({ loading: true, filename: file.name, error: '' })
    const body = new FormData(); body.append('scan', file)
    try {
      const result = await request('/api/obligations/ai-scan', { method: 'POST', body })
      await finishAIScan(result, file.name)
    } catch (error) {
      setAIScan({ loading: false, filename: file.name, error: error.message })
    } finally { event.target.value = '' }
  }
  const saveAIScan = async items => {
    setAIScan(current => ({ ...current, saving: true }))
    try {
      const payload = { items: items.map(item => ({ page: item.page, values: stripObligation(item.values) })) }
      const result = await requestJSONWithDuplicateConfirmation(`/api/obligations/ai-scan/${aiScan.batch}/commit`, 'POST', payload)
      const referenceNote = result.created_references ? `; новых контрагентов в справочнике: ${result.created_references}` : ''
      notify(`Из скана добавлено ${result.created} обязательств${referenceNote}`)
      setAIScan(null); setPage(1); load()
      request('/api/references').then(setRefs).catch(error => notify(error.message, 'error'))
    } catch (error) {
      setAIScan(current => ({ ...current, saving: false }))
      if (!error.duplicateCanceled) notify(error.message, 'error')
    }
  }
  const doSort = key => setSort(current => ({ key, order: current.key === key && current.order === 'asc' ? 'desc' : 'asc' }))
  const approvalEditable = canApproveObligations(user)
  return <div className={`page registry-page ${tableFullscreen ? 'is-table-fullscreen' : ''}`}>
    <PageHeader eyebrow="Рабочая область" title="Реестр обязательств" subtitle={`${data.total.toLocaleString('ru-RU')} записей с учётом фильтров`} actions={<><PresenceCluster users={activeUsers} currentSession={sessionId}/>{can(user, 'desktop.broadcast') && <button className="secondary desktop-broadcast-launch" onClick={() => setBroadcastOpen(true)}><Megaphone size={17}/>Уведомление на ПК</button>}{can(user, 'system.maintenance') && <button className={`maintenance-toggle ${maintenance?.active ? 'is-active' : ''}`} onClick={onToggleMaintenance}><AlertTriangle size={17}/>{maintenance?.active ? 'Завершить обновление' : 'Начать обновление'}</button>}{can(user, 'registry.ai_scan') && <><input ref={aiScanRef} type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={analyzeScan}/><button className="primary ai-scan-launch" onClick={() => aiScanRef.current.click()}><ScanLine size={17}/>AI сканирование</button></>}{can(user, 'registry.import') && <><input ref={importRef} type="file" accept=".xlsx" hidden onChange={importFile}/><button className="secondary" onClick={() => importRef.current.click()}><FileUp size={17}/>Импорт</button></>}{can(user, 'registry.export') && <button className="secondary" onClick={() => download(`/api/obligations/export.xlsx?${query}`, 'Реестр обязательств.xlsx')}><Download size={17}/>Excel</button>}<button className="secondary registry-width-reset" onClick={resetColumnWidths} title="Вернуть стандартную ширину всех столбцов"><RotateCcw size={16}/>Ширина</button><FontSizeButton large={largeTableFont} onToggle={() => setLargeTableFont(value => !value)}/><button className="secondary registry-fullscreen-button" onClick={() => setTableFullscreen(true)} title="Открыть таблицу на весь экран" aria-label="Открыть таблицу на весь экран"><Maximize2 size={17}/></button></>}/>
    <section className="filter-panel">
      <div className="search-box"><Search size={18}/><input placeholder="Контрагент, счёт, комментарий…" value={filters.q} onChange={e => setFilter('q', e.target.value)}/>{filters.q && <button onClick={() => setFilter('q', '')}><X size={15}/></button>}</div>
      <div className="search-box amount-search-box"><Search size={18}/><input inputMode="decimal" placeholder="Поиск по сумме" value={filters.amount} onChange={e => setFilter('amount', e.target.value)}/>{filters.amount && <button onClick={() => setFilter('amount', '')} aria-label="Очистить поиск по сумме"><X size={15}/></button>}</div>
      <label className="filter-date"><span>Дата документа: от</span><DateInput value={filters.document_from} onChange={value => setFilter('document_from', value)} aria-label="Дата документа: от"/></label>
      <label className="filter-date"><span>Дата документа: до</span><DateInput value={filters.document_to} onChange={value => setFilter('document_to', value)} aria-label="Дата документа: до"/></label>
      <button className={`overdue-toggle ${filters.overdue ? 'active' : ''}`} onClick={() => setFilter('overdue', filters.overdue ? '' : 'true')}><Filter size={15}/>Только просроченные</button>
      {hasActiveFilters(filters) && <button className="reset-filters" onClick={() => { setFilters(emptyFilters); setPage(1) }}><RotateCcw size={15}/>Сбросить</button>}
    </section>
    <section className="table-card">
      {tableFullscreen && <div className="registry-fullscreen-controls"><FontSizeButton large={largeTableFont} onToggle={() => setLargeTableFont(value => !value)}/><button type="button" className="registry-fullscreen-exit" onClick={() => setTableFullscreen(false)} title="Вернуться к обычному виду" aria-label="Вернуться к обычному виду"><Minimize2 size={17}/><span>Обычный вид</span></button></div>}
      {selected.length > 0 && <div className="selection-bar"><span><Check size={16}/>{selected.length} выбрано</span>{selectedItem && <button onClick={() => setHistoryItem(selectedItem)}><Info size={15}/>Информация</button>}{can(user, 'registry.split') && selectedItem && canSplitPayment(selectedItem) && <button onClick={() => setSplitItem(selectedItem)}><Scissors size={15}/>Разбить платёж</button>}{can(user, 'registry.edit') && <button onClick={() => setBulkOpen(true)}>{approvalEditable ? 'Изменить статус и даты' : 'Изменить статус / факт оплаты'}</button>}<button onClick={() => setSelected([])}>Снять выбор</button></div>}
      <div ref={tableWrapRef} className="registry-table-wrap" onScroll={rememberScroll} onPointerDown={startTableDrag} onPointerMove={moveTableDrag} onPointerUp={finishTableDrag} onPointerCancel={finishTableDrag} onLostPointerCapture={finishTableDrag} onClickCapture={suppressTableClick}><table className={`registry-table inline-registry ${largeTableFont ? 'registry-font-large' : ''}`} style={{ '--registry-table-width': `${tableWidth}px`, '--registry-counterparty-left': `${stickyOffsets.counterparty}px`, '--registry-entry-date-left': `${stickyOffsets.entryDate}px`, '--registry-account-type-left': `${stickyOffsets.accountType}px`, '--registry-legal-entity-left': `${stickyOffsets.legalEntity}px` }}><colgroup>{columnWidths.map((width, index) => <col key={index} style={{ width }}/>)}</colgroup><thead><tr><th className="check-col">{can(user, 'registry.create') ? <button type="button" className={`inline-add-row ${newRow ? 'active' : ''}`} onClick={addInlineRow} title={newRow ? 'Убрать новую строку' : 'Добавить строку'} aria-label={newRow ? 'Убрать новую строку' : 'Добавить строку'}><Plus size={16}/></button> : <input type="checkbox" checked={allSelected} onChange={toggleAll}/>}</th>
        <ColumnHead className="counterparty-head" label="Контрагент" field="counterparty" sort={sort} onSort={doSort} value={filters.counterparty} options={refs.counterparties} onFilter={value => setFilter('counterparty', value)} multiple {...resizeProps(1)}/>
        <ColumnHead className="entry-date-head" label="Дата внесения" field="entry_date" sort={sort} onSort={doSort} dateValue={filters.entry_date} onDateFilter={value => setFilter('entry_date', value)} {...resizeProps(2)}/>
        <ColumnHead className="account-type-head" label="Признак" value={filters.account_type} options={refs.account_types} onFilter={value => setFilter('account_type', value)} allowBlank {...resizeProps(3)}/>
        <ColumnHead className="legal-entity-head" label="Юрлицо" field="legal_entity" sort={sort} onSort={doSort} value={filters.legal_entity} options={refs.legal_entities} onFilter={value => setFilter('legal_entity', value)} {...resizeProps(4)}/>
        <ColumnHead label="Сумма" field="amount" sort={sort} onSort={doSort} {...resizeProps(5)}/>
        <PlainColumnHead label="Документ" {...resizeProps(6)}/><ColumnHead label="Дата документа" dateValue={filters.document_date} onDateFilter={value => setFilter('document_date', value)} {...resizeProps(7)}/>
        <ColumnHead label="Статья затрат" value={filters.cost_category} options={refs.cost_categories} onFilter={value => setFilter('cost_category', value)} {...resizeProps(8)}/>
        <PlainColumnHead label="Отсрочка, дней" {...resizeProps(9)}/>
        <ColumnHead label="Плановая оплата" field="planned_payment_date" sort={sort} onSort={doSort} dateValue={filters.planned_payment_date} onDateFilter={value => setFilter('planned_payment_date', value)} {...resizeProps(10)}/>
        <ColumnHead label="Дата утверждения" field="approval_date" sort={sort} onSort={doSort} dateValue={filters.approval_date} onDateFilter={value => setFilter('approval_date', value)} {...resizeProps(11)}/>
        <ColumnHead label="Фактическая оплата" dateValue={filters.actual_payment_date} onDateFilter={value => setFilter('actual_payment_date', value)} {...resizeProps(12)}/>
        <ColumnHead label="Статус" field="status" sort={sort} onSort={doSort} value={filters.status} options={refs.statuses} onFilter={value => setFilter('status', value)} {...resizeProps(13)}/>
        <ColumnHead label="Срочность" value={filters.urgency} options={refs.urgencies} onFilter={value => setFilter('urgency', value)} {...resizeProps(14)}/>
        <ColumnHead label="Ответственный" value={filters.responsible} options={refs.responsibles} onFilter={value => setFilter('responsible', value)} {...resizeProps(15)}/>
        <ColumnHead label="Приоритет" value={filters.priority} options={refs.priorities} onFilter={value => setFilter('priority', value)} {...resizeProps(16)}/>
        <PlainColumnHead label="Комментарий" {...resizeProps(17)}/><PlainColumnHead label="Условия оплаты" {...resizeProps(18)}/><th className="action-col"/></tr></thead>
      <tbody>{newRow && <RegistryRow item={newRow} refs={refs} editable approvalEditable={approvalEditable} isNew savingCells={savingCells} onCommit={commitNewCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onCreateCounterparty={entered => openCounterpartyModal(newRow, entered)} onDelete={() => setNewRow(null)}/>} {loading ? <SkeletonRows/> : data.items.length === 0 && !newRow ? <tr><td colSpan="20"><div className="empty-state"><Search size={27}/><strong>Ничего не найдено</strong><span>Измените или сбросьте фильтры</span></div></td></tr> : data.items.map(item => <RegistryRow key={item.id} item={item} refs={refs} editable={can(user, 'registry.edit')} approvalEditable={approvalEditable} selected={selected.includes(item.id)} savingCells={savingCells} onToggle={() => setSelected(s => s.includes(item.id) ? s.filter(id => id !== item.id) : [...s, item.id])} onCommit={commitCell} onStartEdit={startCellEdit} onFinishEdit={finishCellEdit} onCreateCounterparty={entered => openCounterpartyModal(item, entered)} onScanChanged={meta => updateScanMeta(item.id, meta)} notify={notify} onInfo={() => setHistoryItem(item)} onSplit={can(user, 'registry.split') && canSplitPayment(item) ? () => setSplitItem(item) : null} onDelete={can(user, 'registry.delete') ? () => remove(item.id) : null}/>)}</tbody></table></div>
      <footer className="table-footer"><div className="table-footer-summary" aria-live="polite" aria-busy={loading}><span>Показано {data.items.length} из {data.total.toLocaleString('ru-RU')}</span><span className="table-footer-total"><b>Сумма по фильтрам</b><strong>{loading ? 'Считаем…' : money(data.filtered_amount)}</strong></span></div><div><button disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17}/></button><span>Страница <b>{page}</b> из {totalPages}</span><button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={17}/></button></div></footer>
    </section>
    {bulkOpen && (
      <BulkModal count={selected.length} refs={refs} approvalEditable={approvalEditable} onClose={() => setBulkOpen(false)} onSave={async values => { try { await request('/api/obligations/bulk', { method: 'POST', body: JSON.stringify({ ids: selected, ...values }) }); notify('Выбранные строки обновлены'); setBulkOpen(false); setSelected([]); load() } catch (e) { notify(e.message, 'error') } }}/>
    )}
    {splitItem && <SplitPaymentModal item={splitItem} refs={refs} onClose={() => setSplitItem(null)} onSave={values => splitPayment(splitItem, values)}/>}
    {historyItem && <ObligationHistoryModal item={historyItem} notify={notify} onClose={() => setHistoryItem(null)}/>}
    {aiScan && <AIScanModal state={aiScan} references={refs} approvalEditable={approvalEditable} onChange={setAIScan} onRetry={() => aiScanRef.current.click()} onClose={() => !aiScan.loading && !aiScan.saving && setAIScan(null)} onSave={saveAIScan}/>}
    {duplicatePrompt && <DuplicateObligationModal conflict={duplicatePrompt} onCancel={() => finishDuplicatePrompt(false)} onConfirm={() => finishDuplicatePrompt(true)}/>}
    {counterpartyModal && <CounterpartyModal value={counterpartyModal.value} taxID={counterpartyModal.taxID} initialMode={counterpartyModal.mode} lookupPath="/api/registry/counterparties/fns/lookup" onClose={() => setCounterpartyModal(null)} onSave={addCounterpartyFromRegistry}/>}
    {broadcastOpen && <DesktopBroadcastModal
      onClose={() => setBroadcastOpen(false)}
      onSent={created => { setBroadcastOpen(false); notify(`Уведомление отправлено: ${created} получателей`) }}
    />}
  </div>
}

export function DuplicateObligationModal({ conflict, onCancel, onConfirm }) {
  const matches = conflict.duplicates || []
  const total = conflict.duplicate_total || matches.length
  return <div className="modal-backdrop duplicate-obligation-backdrop" onMouseDown={event => event.target === event.currentTarget && onCancel()}>
    <section className="modal duplicate-obligation-modal" role="alertdialog" aria-modal="true" aria-labelledby="duplicate-obligation-title">
      <header className="modal-head">
        <div><p className="eyebrow">Защита от повторного ввода</p><h2 id="duplicate-obligation-title"><AlertTriangle size={22}/>Возможный дубликат счёта</h2><span>Сохранение остановлено. Сначала сравните найденные записи.</span></div>
        <button type="button" onClick={onCancel} aria-label="Закрыть"><X/></button>
      </header>
      <div className="modal-body duplicate-obligation-body">
        <div className="duplicate-obligation-warning"><AlertTriangle size={19}/><div><strong>Найдено совпадений: {total}</strong><span>Проверяются варианты написания контрагента и номера документа, ИНН, юридическое лицо, дата и сумма. Если это действительно отдельный счёт, сохранение можно подтвердить вручную.</span></div></div>
        <div className="duplicate-obligation-list">{matches.map((item, index) => <article key={`${item.id || 'incoming'}-${index}`}>
          <header><div><b>{item.id ? `Запись №${item.id}` : 'Запись из текущей операции'}</b>{item.source_row ? <span>строка источника {item.source_row}</span> : null}</div><em className={`duplicate-confidence ${item.confidence}`}>{item.confidence === 'exact' ? 'Точное совпадение' : item.confidence === 'high' ? 'Высокая вероятность' : 'Требует проверки'}</em></header>
          <div className="duplicate-obligation-fields"><span><small>Контрагент</small><strong>{item.counterparty || '—'}</strong></span><span><small>Юрлицо</small><strong>{item.legal_entity || '—'}</strong></span><span><small>Документ</small><strong>{item.document_number || '—'}</strong></span><span><small>Дата документа</small><strong>{shortDate(item.document_date) || '—'}</strong></span><span><small>Сумма</small><strong>{item.amount == null ? '—' : money(item.amount)}</strong></span><span><small>Статус</small><strong>{item.status || '—'}</strong></span></div>
          <ul>{(item.reasons || []).map(reason => <li key={reason}>{reason}</li>)}</ul>
        </article>)}</div>
        {total > matches.length && <p className="duplicate-obligation-more">Показаны первые {matches.length} из {total} совпадений.</p>}
      </div>
      <footer className="modal-footer duplicate-obligation-actions"><button type="button" className="secondary" onClick={onCancel}>Вернуться и исправить</button><button type="button" className="danger duplicate-obligation-confirm" onClick={onConfirm}><span className="duplicate-obligation-confirm-icon"><AlertTriangle size={17}/></span><span>Продолжить всё равно</span></button></footer>
    </section>
  </div>
}

function FontSizeButton({ large, onToggle }) {
  return <button type="button" className={`secondary registry-font-button ${large ? 'active' : ''}`} onClick={onToggle} aria-pressed={large} aria-label={large ? 'Вернуть обычный размер шрифта в таблице' : 'Увеличить размер шрифта в таблице'} title={large ? 'Обычный шрифт' : 'Увеличить шрифт'}><span aria-hidden="true">A<sup>+</sup></span><b>{large ? 'Обычный' : 'Крупнее'}</b></button>
}

function ColumnHead({ label, field, sort, onSort, value = '', options, onFilter, dateValue = '', onDateFilter, className = '', multiple = false, allowBlank = false, ...resize }) {
  const sorted = field && sort?.key === field
  const filtered = (Array.isArray(value) ? value.length > 0 : Boolean(value)) || Boolean(dateValue)
  return <th className={`${className} ${sorted ? 'sorted' : ''} ${filtered ? 'filtered' : ''}`}><div className="column-head-inner">
    {field ? <button type="button" className="column-sort" onClick={() => onSort(field)}>{label}<i>{sorted ? (sort.order === 'asc' ? '↑' : '↓') : '↕'}</i></button> : <span className="column-label">{label}</span>}
    {onFilter && <HeaderFilter label={label} value={value} options={options} onChange={onFilter} multiple={multiple} allowBlank={allowBlank}/>}
    {onDateFilter && <DateHeaderFilter label={label} value={dateValue} onChange={onDateFilter}/>}
  </div><ColumnResizeHandle {...resize}/></th>
}

function PlainColumnHead({ label, ...resize }) {
  return <th><span className="column-label">{label}</span><ColumnResizeHandle {...resize}/></th>
}

function ColumnResizeHandle({ columnIndex, columnWidth, onResizeStart, onResizeBy, onResizeReset }) {
  const onKeyDown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    onResizeBy(columnIndex, event.key === 'ArrowLeft' ? -10 : 10)
  }
  return <span className="column-resize-handle" role="separator" tabIndex="0" aria-label="Изменить ширину столбца" aria-orientation="vertical" aria-valuenow={columnWidth} onPointerDown={event => onResizeStart(columnIndex, event)} onKeyDown={onKeyDown} onDoubleClick={() => onResizeReset(columnIndex)} title="Потяните для изменения ширины; двойной щелчок — сброс"/>
}

function DateHeaderFilter({ label, value, onChange }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  return <div className={`header-filter date-header-filter ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
    <button ref={triggerRef} type="button" className="header-filter-trigger" aria-label={`Фильтр по дате: ${label}`} aria-expanded={open} onClick={() => setOpen(current => !current)}><CalendarDays size={13}/>{value && <i/>}</button>
    {open && <DateInput value={value} onChange={next => { onChange(next); setOpen(false) }} onClose={() => setOpen(false)} closeOnScroll={false} anchorRef={triggerRef} triggerOnly aria-label={`Дата фильтра: ${label}`} autoFocus/>}
  </div>
}

function HeaderFilter({ label, value, options = [], onChange, multiple = false, allowBlank = false }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const normalizedOptions = useMemo(() => {
    const unique = new Map()
    options.forEach(option => {
      const optionValue = typeof option === 'string' ? option : option.value
      if (optionValue && !unique.has(optionValue)) unique.set(optionValue, { value: optionValue, taxID: typeof option === 'string' ? '' : (option.tax_id || ''), searchText: referenceOptionSearchText(option) })
    })
    return [...unique.values()]
  }, [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? normalizedOptions.filter(option => option.searchText.toLocaleLowerCase('ru-RU').includes(term)) : normalizedOptions }, [search, normalizedOptions])
  const selectedValues = multiple ? (Array.isArray(value) ? value : value ? [value] : []) : value ? [value] : []
  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])
  const select = next => {
    if (!multiple) { onChange(next); setSearch(''); setOpen(false); return }
    if (!next) { onChange([]); return }
    onChange(selectedValues.includes(next) ? selectedValues.filter(item => item !== next) : [...selectedValues, next])
  }
  return <div ref={rootRef} className={`header-filter ${open ? 'is-open' : ''} ${selectedValues.length ? 'has-value' : ''}`}>
    <button type="button" className="header-filter-trigger" aria-label={`Фильтр: ${label}${multiple && selectedValues.length ? `, выбрано ${selectedValues.length}` : ''}`} aria-expanded={open} onClick={() => { setSearch(''); setOpen(current => !current) }}><ChevronDown size={13}/>{selectedValues.length > 0 && <i/>}</button>
    {open && <div className="header-filter-menu">
      <div className="header-filter-search"><Search size={15}/><input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder={label === 'Контрагент' ? 'Название или ИНН' : 'Поиск по наименованию'} aria-label={`Поиск: ${label}`}/>{search && <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X size={13}/></button>}</div>
      <div className="header-filter-options" role="listbox" aria-multiselectable={multiple || undefined} aria-label={`Значения: ${label}`}>
        <button type="button" className={!selectedValues.length ? 'selected' : ''} onClick={() => select('')}><span>Все значения</span>{!selectedValues.length && <Check size={14}/>}</button>
        {allowBlank && <button type="button" className={selectedValues.includes(BLANK_ACCOUNT_TYPE_FILTER) ? 'selected' : ''} onClick={() => select(BLANK_ACCOUNT_TYPE_FILTER)} role="option" aria-selected={selectedValues.includes(BLANK_ACCOUNT_TYPE_FILTER)}><span>Не выбран (—)</span>{selectedValues.includes(BLANK_ACCOUNT_TYPE_FILTER) && <Check size={14}/>}</button>}
        {visible.map(option => { const selected = selectedValues.includes(option.value); return <button type="button" key={option.value} className={selected ? 'selected' : ''} onClick={() => select(option.value)} title={option.taxID ? `${option.value} · ИНН ${option.taxID}` : option.value} role="option" aria-selected={selected}><span>{option.value}{option.taxID && <small>ИНН {option.taxID}</small>}</span>{selected && <Check size={14}/>}</button> })}
        {!visible.length && <p>Ничего не найдено</p>}
      </div>
    </div>}
  </div>
}

function normalizeSavedFilters(saved) {
  const counterparty = Array.isArray(saved.counterparty) ? saved.counterparty.filter(Boolean) : saved.counterparty ? [saved.counterparty] : []
  const normalized = { ...emptyFilters, ...saved, counterparty }
  delete normalized.planned_from
  delete normalized.planned_to
  return normalized
}

function normalizeSavedView(saved) {
  const structured = saved && typeof saved.filters === 'object' && !Array.isArray(saved.filters)
  const filters = normalizeSavedFilters(structured ? saved.filters : (saved || {}))
  const savedPage = structured ? Number(saved.page) : 1
  const savedSort = structured && saved.sort && typeof saved.sort === 'object' ? saved.sort : {}
  const sortKeys = ['entry_date', 'counterparty', 'legal_entity', 'amount', 'planned_payment_date', 'approval_date', 'status', 'priority', 'updated_at']
  const sortKey = sortKeys.includes(savedSort.key) ? savedSort.key : 'updated_at'
  const order = savedSort.order === 'asc' ? 'asc' : 'desc'
  return {
    filters,
    page: Number.isInteger(savedPage) && savedPage > 0 ? savedPage : 1,
    sort: { key: sortKey, order },
    scroll_left: structured ? Math.max(0, Number(saved.scroll_left) || 0) : 0,
    scroll_top: structured ? Math.max(0, Number(saved.scroll_top) || 0) : 0,
    fullscreen: structured && saved.fullscreen === true,
  }
}

function hasActiveFilters(filters) {
  return Object.values(filters).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value))
}

export function RegistryRow({ item, refs, editable, approvalEditable = false, isNew = false, selected, savingCells, onToggle, onCommit, onStartEdit, onFinishEdit, onCreateCounterparty, onScanChanged, notify, onInfo, onSplit, onDelete, showSelection = true, scanEditable = editable, scanURL }) {
  const saving = field => savingCells.has(`${isNew ? 'new' : item.id}:${field}`)
  const cell = (field, props = {}) => <EditableCell item={item} field={field} label={fieldLabels[field]} editable={editable} saving={saving(field)} onCommit={onCommit} onStartEdit={onStartEdit} onFinishEdit={onFinishEdit} {...props}/>
  return <tr className={`${isNew ? 'inline-new-row' : rowTone(item)}`}>
    <td className="check-col">{isNew ? <button type="button" className="cancel-inline-row" onClick={onDelete} title="Отменить новую строку"><X size={14}/></button> : <div className="registry-row-controls">{showSelection && <label className="registry-row-selector" title="Выбрать строку"><input type="checkbox" checked={selected} onChange={onToggle}/><span aria-hidden="true"><Check size={12}/></span></label>}{(scanEditable || item.has_scan) && <ObligationScanControl item={item} editable={scanEditable} notify={notify} onChanged={onScanChanged} scanURL={scanURL}/>}</div>}</td>
    {cell('counterparty', { className: 'counterparty-cell', options: refs.counterparties, allowCustom: true, onCreateCustom: onCreateCounterparty })}
    {cell('entry_date', { type: 'date', className: 'entry-date-cell' })}
    {cell('account_type', { options: refs.account_types, className: 'account-type-cell' })}
    {cell('legal_entity', { options: refs.legal_entities, className: 'legal-entity-cell' })}
    {cell('amount', { type: 'number', className: 'money-cell', render: value => value == null || value === '' ? '—' : <span className="installment-amount"><span>{money(value)}</span>{item.installment_count > 1 && <small>Платёж {item.installment_number} из {item.installment_count}</small>}</span> })}
    {cell('document_number')}
    {cell('document_date', { type: 'date' })}
    {cell('cost_category', { options: refs.cost_categories, className: 'category-cell' })}
    {cell('deferment_days', { type: 'number' })}
    {cell('planned_payment_date', { type: 'date', className: item.overdue ? 'date-overdue' : '' })}
    {cell('approval_date', { type: 'date', editable: editable && approvalEditable })}
    {cell('actual_payment_date', { type: 'date' })}
    {cell('status', { options: approvalStatusOptions(refs.statuses, approvalEditable), render: value => <Status value={value}/> })}
    {cell('urgency', { options: refs.urgencies, render: value => <Urgency value={value}/> })}
    {cell('responsible', { options: refs.responsibles })}
    {cell('priority', { options: refs.priorities })}
    {cell('comment', { className: 'comment-cell' })}
    {cell('source_note', { className: 'comment-cell' })}
    <td className="action-col">{!isNew && (onInfo || onSplit || onDelete) && <div className="row-actions">{onInfo && <button className="info-button" onClick={onInfo} title="Информация и история изменений" aria-label={`Информация о записи №${item.id}`}><Info size={16}/></button>}{onSplit && <button className="split-button" onClick={onSplit} title="Разбить платёж"><Scissors size={16}/></button>}{onDelete && <button className="danger-button" onClick={onDelete} title="Удалить"><Trash2 size={16}/></button>}</div>}</td>
  </tr>
}

export function ObligationScanControl({ item, editable, notify, onChanged, scanURL = `/api/obligations/${item.id}/scan` }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [preview, setPreview] = useState({ loading: false, url: '', type: '', error: '' })
  const [previewVersion, setPreviewVersion] = useState(0)
  const inputRef = useRef(null)
  const chooseFile = () => inputRef.current?.click()
  const closeModal = () => { if (!busy) { setOpen(false); setConfirmDelete(false) } }
  useEffect(() => {
    if (!open || !item.has_scan) return
    let active = true
    let objectURL = ''
    setPreview({ loading: true, url: '', type: '', error: '' })
    requestBlob(scanURL).then(blob => {
      if (!active) return
      objectURL = URL.createObjectURL(blob)
      setPreview({ loading: false, url: objectURL, type: blob.type, error: '' })
    }).catch(error => { if (active) setPreview({ loading: false, url: '', type: '', error: error.message }) })
    return () => { active = false; if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [open, item.id, item.has_scan, item.scan_name, item.scan_size, previewVersion, scanURL])
  useEffect(() => {
    if (!open) return
    const closeOnEscape = event => { if (event.key === 'Escape') closeModal() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [open, busy])
  const upload = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const form = new FormData()
    form.append('scan', file)
    setBusy(true)
    try {
      const meta = await request(`/api/obligations/${item.id}/scan`, { method: 'POST', body: form })
      onChanged(meta); setConfirmDelete(false); setPreviewVersion(version => version + 1); setOpen(true); notify('Скан документа сохранён')
    } catch (error) { notify(error.message, 'error') } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true)
    try {
      await request(`/api/obligations/${item.id}/scan`, { method: 'DELETE' })
      onChanged(null); setOpen(false); setConfirmDelete(false); notify('Скан документа удалён')
    } catch (error) { notify(error.message, 'error') } finally { setBusy(false) }
  }
  return <>
    <input ref={inputRef} className="scan-file-input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={upload}/>
    <button type="button" className={`scan-cell-button ${item.has_scan ? 'has-scan' : ''}`} disabled={busy || (!editable && !item.has_scan)} onClick={() => { setConfirmDelete(false); item.has_scan ? setOpen(true) : chooseFile() }} title={item.has_scan ? `Открыть: ${item.scan_name}` : editable ? 'Загрузить скан документа' : 'Скан не загружен'} aria-label={item.has_scan ? `Открыть скан документа для записи №${item.id}` : `Загрузить скан документа для записи №${item.id}`}>
      {item.has_scan ? <FileText size={16}/> : <Paperclip size={16}/>}<span>{busy ? '…' : 'Скан'}</span>{item.has_scan && <i aria-hidden="true"/>}
    </button>
    {open && createPortal(<div className="modal-backdrop scan-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeModal() }}><section className="modal scan-document-modal" role="dialog" aria-modal="true" aria-label={`Скан документа для записи №${item.id}`}>
      <header className="modal-head scan-document-head"><div><p className="eyebrow">Документ платежа · запись №{item.id}</p><h2>Просмотр скана</h2><span title={item.scan_name}>{item.scan_name || 'Файл прикреплён к записи'}</span></div><button type="button" onClick={closeModal} aria-label="Закрыть"><X size={18}/></button></header>
      <div className="scan-document-layout">
        <aside className="scan-document-summary"><div className="scan-document-icon"><FileText size={30}/></div><div className="scan-document-meta"><strong title={item.scan_name}>{item.scan_name}</strong><span>{formatFileSize(item.scan_size)}</span>{item.scan_updated_at && <span>Загружен {formatScanDate(item.scan_updated_at)}</span>}<small>{item.counterparty || 'Контрагент не указан'}{item.document_number ? ` · ${item.document_number}` : ''}</small></div></aside>
        <div className="scan-document-preview" aria-live="polite">{preview.loading ? <div className="scan-preview-state"><LoaderCircle className="spin" size={30}/><strong>Загружаем документ…</strong></div> : preview.error ? <div className="scan-preview-state error"><AlertTriangle size={30}/><strong>{preview.error}</strong><button type="button" className="secondary" onClick={() => setPreviewVersion(version => version + 1)}>Повторить</button></div> : preview.url ? (preview.type.startsWith('image/') ? <img src={preview.url} alt={`Скан ${item.scan_name}`}/> : <iframe src={preview.url} title={`Скан ${item.scan_name}`}/>) : null}</div>
      </div>
      <footer className="modal-footer scan-document-actions">{preview.url && <a className="secondary" href={preview.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>Открыть отдельно</a>}{editable && <><button type="button" className="secondary" disabled={busy} onClick={chooseFile}><FileUp size={16}/>Заменить файл</button><button type="button" className={`danger ${confirmDelete ? 'confirming' : ''}`} disabled={busy} onClick={remove}><Trash2 size={16}/>{confirmDelete ? 'Нажмите ещё раз для удаления' : 'Удалить'}</button></>}</footer>
    </section></div>, document.body)}
  </>
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} Б`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`
  return `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`
}

function formatScanDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

function EditableCell({ item, field, label, editable, saving, type = 'text', options, allowCustom = false, onCreateCustom, className = '', render, onCommit, onStartEdit, onFinishEdit }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const begin = () => {
    if (!editable || editing) return
    setDraft(cellEditorValue(field, item[field])); setEditing(true); onStartEdit(item, field)
  }
  const cancel = () => { setEditing(false); onFinishEdit(item) }
  const commit = async () => { const ok = await onCommit(item, field, draft); if (ok) setEditing(false) }
  const keyDown = event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
  }
  const display = render ? render(item[field]) : type === 'date' ? shortDate(item[field]) : (item[field] ?? '') || '—'
  const ariaValue = cellAriaValue(field, item[field])
  return <td className={`editable-cell ${className} ${editing ? 'is-editing' : ''} ${saving ? 'is-saving' : ''}`} aria-label={`${label}: ${ariaValue}`} onClick={begin} title={!editing ? `${label}: ${ariaValue}${editable ? '\nНажмите, чтобы изменить' : ''}` : undefined}>
    {editing ? options ? <InlineCellSelect label={label} value={item[field] || ''} options={options} allowCustom={allowCustom} onChoose={value => { setDraft(value); onCommit(item, field, value).then(ok => ok && setEditing(false)) }} onCreateCustom={value => { setDraft(value); setEditing(false); onCreateCustom?.(value) }} onCancel={cancel}/> : type === 'date' ? <DateInput className="inline-cell-input" value={item[field] || ''} onChange={value => onCommit(item, field, value).then(ok => ok && setEditing(false))} onClose={() => { setEditing(false); onFinishEdit(item) }} aria-label={label} autoFocus/> : <input className="inline-cell-input" type={type === 'number' ? 'number' : 'text'} placeholder="Введите значение" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} autoFocus/> : <div className="cell-display"><div className="cell-display-value">{display}</div></div>}
    {saving && <i className="cell-saving-dot"/>}
  </td>
}

export function InlineCellSelect({ label, value, options = [], allowCustom, onChoose, onCreateCustom, onCancel }) {
  const [search, setSearch] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const normalizedOptions = useMemo(() => normalizedCounterpartyOptions(options), [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? normalizedOptions.filter(option => option.searchText.includes(term)) : normalizedOptions }, [search, normalizedOptions])
  useEffect(() => {
    const outside = event => { if (!rootRef.current?.contains(event.target)) onCancel() }
    document.addEventListener('mousedown', outside)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => document.removeEventListener('mousedown', outside)
  }, [])
  const normalizedSearchTaxID = search.replace(/\D/g, '')
  const exactOption = normalizedOptions.find(option => option.value.toLocaleLowerCase('ru-RU') === search.trim().toLocaleLowerCase('ru-RU') || (normalizedSearchTaxID && option.taxID === normalizedSearchTaxID))
  const useCustom = search.trim() && !exactOption
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (exactOption) onChoose(exactOption.value)
      else if (allowCustom && search.trim()) (onCreateCustom || onChoose)(search.trim())
      else if (visible[0]) onChoose(visible[0].value)
    }
  }
  return <div ref={rootRef} className="inline-select-menu" onClick={event => event.stopPropagation()}>
    <div className="inline-select-search"><Search size={14}/><input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={keyDown} placeholder={label === 'Контрагент' ? 'Название или ИНН' : 'Поиск по наименованию'} aria-label={`Поиск значения: ${label}`}/></div>
    <div className="inline-select-options">
      <button type="button" className={!value ? 'selected' : ''} onClick={() => onChoose('')}><span>Не выбрано</span>{!value && <Check size={13}/>}</button>
      {allowCustom && useCustom && <button type="button" className="custom-value" onClick={() => (onCreateCustom || onChoose)(search.trim())}><span>Завести нового контрагента «{search.trim()}»</span><Plus size={13}/></button>}
      {visible.map(option => <button type="button" key={option.value} className={option.value === value ? 'selected' : ''} onClick={() => onChoose(option.value)} title={option.taxID ? `${option.value} · ИНН ${option.taxID}` : option.value}><span>{option.value}{option.taxID && <small>ИНН {option.taxID}</small>}</span>{option.value === value && <Check size={13}/>}</button>)}
      {!visible.length && !(allowCustom && useCustom) && <p>Ничего не найдено</p>}
    </div>
  </div>
}

function Status({ value }) { return <span className={`status status-${slug(value)}`}>{value || 'Не указан'}</span> }
function Urgency({ value }) { return value ? <span className={`urgency urgency-${slug(value)}`}><i/>{value}</span> : <span className="muted">—</span> }
function slug(value = '') { return ({ 'Оплачено':'paid','К оплате':'to-pay','Зарегистрирован':'registered','Частично оплачено':'partial','Отменено':'cancelled','Критическая':'critical','Срочная':'urgent','Обычная':'normal' }[value] || 'empty') }
function rowTone(item) { return item.overdue ? 'row-overdue' : item.due_soon ? 'row-soon' : item.status === 'К оплате' ? 'row-to-pay' : '' }
function SkeletonRows() { return <>{Array.from({ length: 8 }).map((_, i) => <tr className="skeleton-row" key={i}>{Array.from({ length: 20 }).map((__, j) => <td key={j}><i/></td>)}</tr>)}</> }
export function stripObligation(values) {
  const result = { ...values }
  for (const field of ['id', 'created_at', 'updated_at', 'overdue', 'due_soon', 'split_group_id', 'split_parent_id', 'installment_number', 'installment_count']) delete result[field]
  return result
}
function blankObligation() { return { account_type:'',entry_date:todayISO(),counterparty:'',legal_entity:'',cost_category:'',priority:'',responsible:'',document_number:'',deferment_days:null,document_date:'',amount:null,planned_payment_date:'',approval_date:'',actual_payment_date:'',status:'Зарегистрирован',urgency:'',comment:'',source_note:'' } }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
export function sameCellValue(left, right) { return (left ?? '') === (right ?? '') }
function cellEditorValue(field, value) { if (dateFields.has(field)) return value ? shortDate(value) : ''; return value ?? '' }
function cellAriaValue(field, value) { if (dateFields.has(field)) return shortDate(value); if (field === 'amount' && value != null && value !== '') return money(value); return String(value ?? '') || 'не заполнено' }
export function normalizeCellValue(field, rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue
  if (dateFields.has(field)) return parseInlineDate(value)
  if (field === 'amount') { if (value === '') return null; const number = Number(String(value).replace(',', '.')); if (!Number.isFinite(number)) throw new Error('Введите корректную сумму'); return number }
  if (field === 'deferment_days') { if (value === '') return null; const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new Error('Отсрочка должна быть целым числом'); return number }
  return value
}
function parseInlineDate(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = String(value).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (!match) throw new Error('Введите дату в формате дд/мм/гггг')
  const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Введите корректную дату')
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function PresenceCluster({ users, currentSession }) {
  const [selectedSession, setSelectedSession] = useState(null)
  const selected = users.find(user => user.session_id === selectedSession)
  useEffect(() => { if (selectedSession && !selected) setSelectedSession(null) }, [selectedSession, selected])
  if (!users.length) return <div className="presence-loading" title="Подключаем совместную работу"><i/></div>
  const visible = users.slice(0, 5)
  return <div className="presence-cluster">
    <div className="presence-avatars" aria-label={`Активных пользователей: ${users.length}`}>
      {visible.map(person => <button key={person.session_id} type="button" className={`presence-avatar ${person.mode === 'edit' ? 'is-editing' : ''}`} style={{ '--presence-color': person.color }} data-tooltip={`${person.name}${person.session_id === currentSession ? ' (вы)' : ''}`} aria-label={`${person.name}: ${presenceLocation(person)}`} onClick={() => setSelectedSession(selectedSession === person.session_id ? null : person.session_id)}><span>{initials(person.name)}</span><i/></button>)}
      {users.length > visible.length && <span className="presence-more">+{users.length - visible.length}</span>}
    </div>
    {selected && <div className="presence-popover">
      <div className="presence-popover-head"><span className="presence-avatar static" style={{ '--presence-color': selected.color }}><span>{initials(selected.name)}</span></span><div><strong>{selected.name}{selected.session_id === currentSession ? ' · вы' : ''}</strong><small>{roleLabel(selected.role)}</small></div><button type="button" onClick={() => setSelectedSession(null)}><X size={15}/></button></div>
      <div className="presence-location"><LocateFixed size={17}/><div><span>{selected.mode === 'edit' ? 'Сейчас редактирует' : 'Сейчас просматривает'}</span><strong>{presenceLocation(selected)}</strong>{selected.mode === 'edit' && selected.field_label && <small>Поле: «{selected.field_label}»</small>}</div></div>
      <p>Данные обновляются в реальном времени</p>
    </div>}
  </div>
}

function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?' }
function presenceLocation(person) {
  if (person.mode !== 'edit') return 'Реестр обязательств'
  if (!person.record_id) return 'Новое обязательство'
  return person.source_row ? `Строка ${person.source_row} · запись №${person.record_id}` : `Запись №${person.record_id}`
}

function Field({ label, fieldKey, value, onChange, onFocus, wide, type, ...props }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{type === 'date' ? <DateInput value={value ?? ''} onChange={onChange} onFocus={() => onFocus?.(fieldKey, label)} {...props}/> : <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)} {...props}/>}</label> }
function SelectField({ label, fieldKey, value, options = [], onChange, onFocus, wide, editable }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{editable ? <><input list={`list-${label}`} value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}/><datalist id={`list-${label}`}>{options.map(o => <option key={o.id ?? o.value} value={o.value}/>)}</datalist></> : <select value={value} onChange={e => onChange(e.target.value)} onFocus={() => onFocus?.(fieldKey, label)}><option value="">Не выбрано</option>{options.map(o => <option key={o.id ?? o.value} value={o.value}>{o.value}</option>)}</select>}</label> }

export function SplitPaymentModal({ item, refs, onClose, onSave }) {
  const accountTypes = refs.account_types || []
  const fixedAmountAccountTypes = ['ОМС', 'Коммерция']
  const defaultPaymentDate = item.planned_payment_date || isoDate(new Date())
  const [form, setForm] = useState({ mode: 'count', count: '', payment_dates: [], amount_parts: [{ amount: '', account_type: '', planned_date: '' }], percentage_parts: [{ percent: '', account_type: '', planned_date: '' }, { percent: '', account_type: '', planned_date: '' }], ...createAdvancedSplitFields(defaultPaymentDate, item.account_type || '') })
  const [saving, setSaving] = useState(false)
  const advancedMode = isAdvancedSplitMode(form.mode)
  const preview = useMemo(() => advancedMode ? buildAdvancedSplitPreview(Number(item.amount), form) : buildSplitPreview(Number(item.amount), form), [item.amount, form, advancedMode])
  const splitCount = form.mode === 'amount' ? form.amount_parts.length : preview.items.length
  const showShare = form.mode === 'percentage' || form.mode === 'advance' || form.mode === 'weights'
  const showWeight = form.mode === 'weights'
  const showLabel = form.mode === 'advance'
  const showAccountType = ['percentage', 'amount', 'advance', 'recurring', 'weights'].includes(form.mode)
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const updateCount = value => setForm(current => {
    const count = Number(value)
    const paymentDates = Number.isInteger(count) && count >= 2 && count <= 60
      ? Array.from({ length: count }, (_, index) => current.payment_dates[index] || defaultPaymentDate)
      : []
    return { ...current, count: value, payment_dates: paymentDates }
  })
  const updatePaymentDate = (index, value) => setForm(current => ({ ...current, payment_dates: current.payment_dates.map((date, dateIndex) => dateIndex === index ? value : date) }))
  const updateAmountPart = (index, key, value) => setForm(current => ({ ...current, amount_parts: current.amount_parts.map((part, partIndex) => partIndex === index ? { ...part, [key]: value } : part) }))
  const addAmountPart = () => setForm(current => current.amount_parts.length >= 60 ? current : { ...current, amount_parts: [...current.amount_parts, { amount: '', account_type: '', planned_date: '' }] })
  const removeAmountPart = index => setForm(current => current.amount_parts.length <= 1 ? current : { ...current, amount_parts: current.amount_parts.filter((_, partIndex) => partIndex !== index) })
  const updatePercentagePart = (index, key, value) => setForm(current => ({ ...current, percentage_parts: current.percentage_parts.map((part, partIndex) => partIndex === index ? { ...part, [key]: value } : part) }))
  const addPercentagePart = () => setForm(current => {
    if (current.percentage_parts.length >= 60) return current
    return { ...current, percentage_parts: [...current.percentage_parts, { percent: '', account_type: '', planned_date: '' }] }
  })
  const removePercentagePart = index => setForm(current => current.percentage_parts.length <= 2 ? current : { ...current, percentage_parts: current.percentage_parts.filter((_, partIndex) => partIndex !== index) })
  const submit = async () => {
    if (preview.error || saving) return
    setSaving(true)
    try {
      const values = buildPaymentSplitPayload(form, preview)
      if (!values) return
      await onSave(values)
    } finally { setSaving(false) }
  }
  return <div className="modal-backdrop split-payment-backdrop"><div className="modal split-payment-modal">
    <div className="modal-head"><div><p className="eyebrow">График оплаты</p><h2>Разбить платёж</h2></div><button onClick={onClose} aria-label="Закрыть"><X/></button></div>
    <div className="modal-body split-payment-body">
      <div className="split-source-card"><div><span>Контрагент</span><strong>{item.counterparty || 'Не указан'}</strong><small>{item.document_number ? `Документ ${item.document_number}` : 'Без номера документа'}</small></div><div><span>Общая сумма</span><strong>{money(item.amount)}</strong><small>Сумма графика останется неизменной</small></div></div>
      <div className="split-mode-groups">
        <div><span className="split-mode-label">Основные способы</span><div className="split-mode-tabs" role="tablist"><button type="button" className={form.mode === 'count' ? 'active' : ''} onClick={() => update('mode', 'count')}>Равными частями</button><button type="button" className={form.mode === 'amount' ? 'active' : ''} onClick={() => update('mode', 'amount')}>Заданная сумма</button><button type="button" className={form.mode === 'percentage' ? 'active' : ''} onClick={() => update('mode', 'percentage')}>По процентам</button></div></div>
        <AdvancedSplitModePicker value={form.mode} onChange={mode => update('mode', mode)}/>
      </div>
      {advancedMode ? <AdvancedSplitEditor form={form} setForm={setForm} preview={preview} accountTypes={accountTypes} fixedAmountAccountTypes={fixedAmountAccountTypes} defaultDate={defaultPaymentDate}/> : form.mode === 'percentage' ? <div className="split-percentage-editor">
        <div className="split-percentage-head"><div><strong>Распределение платежа</strong><span>Для каждой доли укажите процент, признак учёта и дату</span></div><b className={preview.percentageTotal === 100 ? 'valid' : ''}>{formatPercent(preview.percentageTotal)} из 100%</b></div>
        <div className="split-percentage-list">{form.percentage_parts.map((part, index) => <div className="split-percentage-row" key={index}>
          <span className="split-percentage-number">{index + 1}</span>
          <label className="field"><span>Доля, %</span><input type="number" min="0.01" max="100" step="0.01" value={part.percent} onChange={event => updatePercentagePart(index, 'percent', event.target.value)}/></label>
          <label className="field"><span>Признак учёта</span><select value={part.account_type} onChange={event => updatePercentagePart(index, 'account_type', event.target.value)}><option value="">Выберите</option>{accountTypes.map(option => <option key={option.id ?? option.value} value={option.value}>{option.value}</option>)}</select></label>
          <label className="field"><span>Плановая дата</span><DateInput value={part.planned_date} onChange={value => updatePercentagePart(index, 'planned_date', value)} aria-label={`Плановая дата доли ${index + 1}`}/></label>
          <div className="split-percentage-amount"><span>Сумма доли</span><strong>{preview.items[index] ? money(preview.items[index].amount) : '—'}</strong></div>
          <button type="button" className="split-percentage-remove" onClick={() => removePercentagePart(index)} disabled={form.percentage_parts.length <= 2} aria-label={`Удалить долю ${index + 1}`} title="Удалить долю"><Trash2 size={16}/></button>
        </div>)}</div>
        <button type="button" className="split-percentage-add" onClick={addPercentagePart} disabled={form.percentage_parts.length >= 60}><Plus size={16}/>Добавить долю</button>
      </div> : form.mode === 'amount' ? <div className="split-percentage-editor split-amount-editor">
        <div className="split-percentage-head split-amount-head"><div><strong>Ручной график платежей</strong><span>Добавьте нужное количество платежей и заполните каждую строку вручную</span></div><b className={preview.amountTotal === Number(item.amount) ? 'valid' : ''}>{money(preview.amountTotal)} из {money(item.amount)}</b></div>
        <div className="split-percentage-list">{form.amount_parts.map((part, index) => <div className="split-percentage-row split-amount-row" key={index}>
          <span className="split-percentage-number">{index + 1}</span>
          <label className="field"><span>Сумма, ₽</span><input type="number" min="0.01" step="0.01" value={part.amount} onChange={event => updateAmountPart(index, 'amount', event.target.value)} aria-label={`Сумма платежа ${index + 1}`}/></label>
          <label className="field"><span>Признак учёта</span><select value={part.account_type} onChange={event => updateAmountPart(index, 'account_type', event.target.value)} aria-label={`Признак учёта платежа ${index + 1}`}><option value="">Выберите</option>{fixedAmountAccountTypes.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
          <label className="field"><span>Плановая дата</span><DateInput value={part.planned_date} onChange={value => updateAmountPart(index, 'planned_date', value)} aria-label={`Плановая дата платежа ${index + 1}`}/></label>
          <button type="button" className="split-percentage-remove" onClick={() => removeAmountPart(index)} disabled={form.amount_parts.length <= 1} aria-label={`Удалить платёж ${index + 1}`} title="Удалить платёж"><Trash2 size={16}/></button>
        </div>)}</div>
        <button type="button" className="split-percentage-add" onClick={addAmountPart} disabled={form.amount_parts.length >= 60}><Plus size={16}/>Добавить платёж</button>
      </div> : <div className="split-settings-grid">
        <label className="field"><span>Количество платежей</span><input type="number" min="2" max="60" value={form.count} onChange={event => updateCount(event.target.value)}/></label>
      </div>}
      {preview.error ? <div className="split-error">{preview.error}</div> : <div className="split-preview">
        <div className="split-preview-head"><div><strong>Предварительный график</strong><span>{preview.items.length} {paymentWord(preview.items.length)}</span></div><div><span>Итого</span><strong>{money(preview.total)}</strong></div></div>
        <div className="split-preview-scroll"><table><thead><tr><th>№</th>{showLabel && <th>Этап</th>}{showWeight && <th>Вес</th>}{showShare && <th>Доля</th>}{showAccountType && <th>Признак учёта</th>}<th>Плановая дата</th><th>Сумма</th></tr></thead><tbody>{preview.items.map(part => <tr key={part.number}><td>{part.number}</td>{showLabel && <td>{part.label}</td>}{showWeight && <td>{part.weight}</td>}{showShare && <td>{formatPercent(part.percent)}</td>}{showAccountType && <td>{part.account_type}</td>}<td className={form.mode === 'count' ? 'split-preview-date' : ''}>{form.mode === 'count' ? <DateInput value={part.date} onChange={value => updatePaymentDate(part.number - 1, value)} aria-label={`Плановая дата платежа ${part.number}`}/> : shortDate(part.date)}</td><td>{money(part.amount)}</td></tr>)}</tbody></table></div>
        {preview.hasRemainder && <p>{advancedMode ? 'Копейки распределены автоматически, поэтому общая сумма графика точно совпадает с исходной.' : 'Последний платёж скорректирован на остаток, поэтому общая сумма совпадает до копейки.'}</p>}
      </div>}
    </div>
    <div className="modal-footer"><button className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button className="primary" onClick={submit} disabled={Boolean(preview.error) || saving}>{saving ? 'Создаём график…' : `Разбить на ${splitCount || 0} ${paymentWord(splitCount || 0)}`}</button></div>
  </div></div>
}

export function canSplitPayment(item) {
  return Number(item?.amount) > 0 && Number(item?.installment_count || 0) <= 1 && !item?.split_group_id && !item?.actual_payment_date && !['Оплачено', 'Отменено'].includes(item?.status)
}

export function ObligationHistoryModal({ item, notify, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    request(`/api/obligations/${item.id}/history`)
      .then(result => { if (active) setData(result) })
      .catch(error => { if (active) { notify(error.message, 'error'); onClose() } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [item.id])

  const record = mergeCurrentObligationRecord(item, data?.record)
  return <div className="modal-backdrop obligation-history-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal obligation-history-modal" role="dialog" aria-modal="true" aria-label={`Информация о записи №${item.id}`}>
      <header className="modal-head obligation-history-head">
        <div><p className="eyebrow">Полный аудит реестра</p><h2>Информация о записи №{item.id}</h2><span>{record.counterparty || 'Контрагент не указан'}{record.document_number ? ` · ${record.document_number}` : ''}</span></div>
        <button type="button" onClick={onClose} aria-label="Закрыть"><X/></button>
      </header>
      <div className="modal-body obligation-history-body">
        {loading ? <div className="obligation-history-loading"><History size={25}/><strong>Загружаем историю изменений…</strong></div> : <>
          <section className="obligation-history-summary">
            <div><Clock3 size={19}/><span><small>Дата и время заведения</small><strong>{historyDateTime(record.created_at)}</strong><b>{record.created_by || 'Система'}</b></span></div>
            <div><History size={19}/><span><small>Последнее изменение</small><strong>{historyDateTime(record.updated_at)}</strong><b>{record.updated_by || 'Система'}</b></span></div>
            <div><Info size={19}/><span><small>Текущее состояние</small><strong>{record.status || 'Статус не указан'}</strong><b>{money(record.amount)}</b></span></div>
          </section>
          <section className="obligation-current-section">
            <header><h3>Подробная информация о платеже</h3><span>Актуальные значения из основного реестра обязательств</span></header>
            <div className="obligation-current-grid">{historyCurrentFields.map(([field, label]) => <div className={field === 'comment' || field === 'source_note' ? 'wide' : ''} key={field}><small>{label}</small><strong>{historyValue(field, record[field])}</strong></div>)}</div>
          </section>
          <section className="obligation-history-section">
            <header><div><h3>История работы сотрудников</h3><span>{data.events.length} {historyEventWord(data.events.length)} в сохранённой истории</span></div></header>
            {data.events.length === 0 ? <div className="obligation-history-empty"><History size={28}/><strong>Изменений после создания не найдено</strong><span>Дата и автор заведения указаны выше.</span></div>
              : <div className="obligation-history-timeline">{data.events.map(event => <article className={`obligation-history-event action-${event.action} ${event.undone_at ? 'is-undone' : ''}`} key={event.id}>
                <i><UserRound size={16}/></i>
                <div className="obligation-history-event-content">
                  <header><div><strong>{historyActionLabels[event.action] || event.description}</strong><span>{event.user}</span></div><time>{historyDateTime(event.created_at)}</time></header>
                  {event.description && <p>{event.description}</p>}
                  {event.undone_at && <div className="obligation-history-undone">Действие отменено {historyDateTime(event.undone_at)}</div>}
                  {event.changes.length > 0 && <div className="obligation-history-changes">{event.changes.map(change => <div key={change.field}>
                    <b>{historyFieldLabels[change.field] || change.field}</b>
                    <span>{historyValue(change.field, change.before)}</span><ArrowRight size={14}/><strong>{historyValue(change.field, change.after)}</strong>
                  </div>)}</div>}
                </div>
              </article>)}</div>}
          </section>
        </>}
      </div>
      <footer className="modal-footer"><button type="button" className="primary" onClick={onClose}>Закрыть</button></footer>
    </section>
  </div>
}

function historyDateTime(value) {
  if (!value) return '—'
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  return match ? `${match[3]}.${match[2]}.${match[1]} · ${match[4]}:${match[5]}:${match[6] || '00'}` : String(value)
}

function historyValue(field, value) {
  if (value == null || value === '') return '—'
  if (field === 'amount') return money(value)
  if (dateFields.has(field)) return shortDate(String(value))
  if (field === 'split_parent_id') return `№${value}`
  return String(value)
}

function historyEventWord(count) {
  const last = count % 10
  const lastTwo = count % 100
  if (last === 1 && lastTwo !== 11) return 'действие'
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'действия'
  return 'действий'
}

function buildSplitPreview(amount, form) {
  const totalCents = Math.round(Number(amount) * 100)
  if (!Number.isFinite(totalCents) || totalCents <= 0) return { error: 'У платежа должна быть положительная сумма.', items: [], total: 0 }
  if (form.mode === 'percentage') {
    const parts = form.percentage_parts || []
    if (parts.length < 2 || parts.length > 60) return { error: 'Количество долей должно быть от 2 до 60.', items: [], total: 0, percentageTotal: 0 }
    const prepared = []
    let totalPoints = 0
    for (let index = 0; index < parts.length; index++) {
      const raw = Number(parts[index].percent)
      const points = Math.round(raw * 100)
      if (!Number.isFinite(raw) || raw <= 0 || raw > 100 || Math.abs(raw * 100 - points) > 0.000001) return { error: `Укажите корректный процент для доли ${index + 1} с точностью до двух знаков.`, items: [], total: 0, percentageTotal: totalPoints / 100 }
      if (!parts[index].account_type) return { error: `Выберите признак учёта для доли ${index + 1}.`, items: [], total: 0, percentageTotal: (totalPoints + points) / 100 }
      if (!parts[index].planned_date || !/^\d{4}-\d{2}-\d{2}$/.test(parts[index].planned_date)) return { error: `Выберите плановую дату для доли ${index + 1}.`, items: [], total: 0, percentageTotal: (totalPoints + points) / 100 }
      prepared.push({ ...parts[index], points, index })
      totalPoints += points
    }
    if (totalPoints !== 10000) return { error: `Сумма долей должна быть ровно 100%, сейчас ${formatPercent(totalPoints / 100)}.`, items: [], total: 0, percentageTotal: totalPoints / 100 }
    const denominator = 10000n
    const total = BigInt(totalCents)
    const allocated = prepared.map(part => { const product = total * BigInt(part.points); return { ...part, cents: product / denominator, remainder: product % denominator } })
    let leftover = total - allocated.reduce((sum, part) => sum + part.cents, 0n)
    const byRemainder = [...allocated].sort((left, right) => Number(right.remainder - left.remainder) || left.index - right.index)
    for (let index = 0; leftover > 0n; index++, leftover--) byRemainder[index % byRemainder.length].cents++
    const centsByIndex = new Map(byRemainder.map(part => [part.index, part.cents]))
    const items = prepared.map((part, index) => ({ number: index + 1, date: part.planned_date, amount: Number(centsByIndex.get(index)) / 100, percent: part.points / 100, account_type: part.account_type }))
    if (items.some(part => part.amount < 0.01)) return { error: 'Одна из долей получается меньше одной копейки.', items: [], total: 0, percentageTotal: 100 }
    return { items, total: items.reduce((sum, part) => sum + part.amount, 0), hasRemainder: allocated.some(part => part.remainder !== 0n), error: '', percentageTotal: 100 }
  }
  if (form.mode === 'amount') {
    const parts = form.amount_parts || []
    const parsedAmounts = parts.map(part => {
      const raw = Number(part.amount)
      const cents = Math.round(raw * 100)
      return { raw, cents, valid: Number.isFinite(raw) && raw > 0 && Math.abs(raw * 100 - cents) <= 0.000001 }
    })
    const amountTotalCents = parsedAmounts.reduce((sum, part) => sum + (part.valid ? part.cents : 0), 0)
    const amountTotal = amountTotalCents / 100
    if (parts.length < 2 || parts.length > 60) return { error: 'Добавьте минимум два платежа.', items: [], total: 0, amountTotal }
    for (let index = 0; index < parts.length; index++) {
      if (!parsedAmounts[index].valid) return { error: `Укажите положительную сумму платежа ${index + 1} с точностью до копеек.`, items: [], total: 0, amountTotal }
      if (!['ОМС', 'Коммерция'].includes(parts[index].account_type)) return { error: `Выберите ОМС или Коммерция для платежа ${index + 1}.`, items: [], total: 0, amountTotal }
      if (!parts[index].planned_date || !/^\d{4}-\d{2}-\d{2}$/.test(parts[index].planned_date)) return { error: `Выберите плановую дату для платежа ${index + 1}.`, items: [], total: 0, amountTotal }
    }
    if (amountTotalCents !== totalCents) {
      const difference = Math.abs(totalCents - amountTotalCents) / 100
      const error = amountTotalCents < totalCents ? `До общей суммы не хватает ${money(difference)}.` : `Сумма графика превышает исходную на ${money(difference)}.`
      return { error, items: [], total: 0, amountTotal }
    }
    const items = parts.map((part, index) => ({ number: index + 1, date: part.planned_date, account_type: part.account_type, amount: parsedAmounts[index].cents / 100 }))
    return { items, total: amountTotal, amountTotal, error: '' }
  }
  const count = Number(form.count)
  if (!Number.isInteger(count) || count < 2 || count > 60) return { error: 'Количество платежей должно быть от 2 до 60.', items: [], total: 0 }
  if (!Array.isArray(form.payment_dates) || form.payment_dates.length !== count) return { error: 'Сформируйте график платежей.', items: [], total: 0 }
  const invalidDateIndex = form.payment_dates.findIndex(date => !date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
  if (invalidDateIndex >= 0) return { error: `Выберите плановую дату для платежа ${invalidDateIndex + 1}.`, items: [], total: 0 }
  const base = Math.floor(totalCents / count)
  if (base < 1) return { error: 'Сумма слишком мала для выбранного количества платежей.', items: [], total: 0 }
  const amounts = Array.from({ length: count }, (_, index) => index === count - 1 ? totalCents - base * (count - 1) : base)
  const items = amounts.map((cents, index) => ({ number: index + 1, date: form.payment_dates[index], amount: cents / 100 }))
  return { items, total: amounts.reduce((sum, cents) => sum + cents, 0) / 100, hasRemainder: amounts.length > 1 && amounts.at(-1) !== amounts[0], error: '' }
}

function formatPercent(value) { return `${Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%` }

function isoDate(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}` }
function paymentWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'платежей' : last === 1 ? 'платёж' : last >= 2 && last <= 4 ? 'платежа' : 'платежей' }
function partWord(value) { const lastTwo = value % 100; const last = value % 10; return lastTwo >= 11 && lastTwo <= 14 ? 'частей' : last === 1 ? 'часть' : last >= 2 && last <= 4 ? 'части' : 'частей' }
function BulkModal({ count, refs, approvalEditable, onClose, onSave }) {
  const [form, setForm] = useState({ status: '', approval_date: '', actual_payment_date: '' })
  const updateApprovalDate = value => setForm(current => withDerivedObligationValues({ ...current, approval_date: value }, 'approval_date'))
  const updateActualPaymentDate = value => setForm(current => withDerivedObligationValues({ ...current, actual_payment_date: value }, 'actual_payment_date'))
  return <div className="modal-backdrop"><div className="modal small-modal"><div className="modal-head"><div><p className="eyebrow">Массовое действие</p><h2>Изменить {count} строк</h2></div><button onClick={onClose}><X/></button></div><div className="modal-body stacked-fields"><SelectField label="Новый статус" value={form.status} options={approvalStatusOptions(refs.statuses, approvalEditable)} onChange={v => setForm({ ...form, status: v })}/>{approvalEditable && <Field label="Дата утверждения" type="date" value={form.approval_date} onChange={updateApprovalDate}/>}<Field label="Фактическая дата оплаты" type="date" value={form.actual_payment_date} onChange={updateActualPaymentDate}/>{!approvalEditable && <p className="approval-role-note">Статус «К оплате» и дату утверждения устанавливает только руководитель или программист.</p>}</div><div className="modal-footer"><button className="secondary" onClick={onClose}>Отмена</button><button className="primary" onClick={() => onSave(form)}>Применить</button></div></div></div>
}


