import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, FileSearch, LoaderCircle, ScanLine, Search, Sparkles, X } from 'lucide-react'
import { DateInput, money } from './App'
import { requestBlob } from './api'

const automaticFields = [
  ['counterparty', 'Контрагент'], ['entry_date', 'Дата внесения'], ['legal_entity', 'Юридическое лицо'],
  ['amount', 'Сумма'], ['document_number', 'Документ'], ['document_date', 'Дата документа'],
]

export default function AIScanModal({ state, references, onChange, onRetry, onClose, onSave }) {
  const [activePage, setActivePage] = useState(state.items?.[0]?.page || 1)
  const items = state.items || []
  const active = items.find(item => item.page === activePage) || items[0]
  const selected = items.filter(item => item.include)
  const missing = selected.flatMap(item => requiredMissing(item).map(field => ({ page: item.page, field })))
  const updateItem = (page, updater) => onChange(current => ({ ...current, items: current.items.map(item => item.page === page ? updater(item) : item) }))
  const updateValue = (field, value) => updateItem(active.page, item => ({ ...item, values: { ...item.values, [field]: value } }))
  const submit = () => {
    if (!selected.length || missing.length) return
    onSave(selected)
  }

  return <div className="modal-backdrop ai-scan-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="modal ai-scan-modal" role="dialog" aria-modal="true" aria-label="AI сканирование документов">
      <header className="modal-head ai-scan-head">
        <div><p className="eyebrow">Локальное распознавание · данные не покидают сервер</p><h2><ScanLine size={22}/>AI сканирование</h2><span>{state.filename}</span></div>
        <button type="button" onClick={onClose} disabled={state.loading || state.saving} aria-label="Закрыть"><X/></button>
      </header>
      {state.loading ? <div className="ai-scan-state"><LoaderCircle className="spin" size={38}/><strong>Распознаём страницы документа</strong><span>Проверяем ориентацию, текст, суммы и реквизиты. Многостраничный PDF может обрабатываться несколько минут.</span></div>
        : state.error ? <div className="ai-scan-state error"><AlertTriangle size={38}/><strong>Документ не распознан</strong><span>{state.error}</span><button type="button" className="primary" onClick={onRetry}>Выбрать другой файл</button></div>
        : <div className="ai-scan-layout">
          <aside className="ai-scan-pages">
            <header><strong>Найдено счетов: {items.length}</strong><span>Выбрано: {selected.length}</span></header>
            <div>{items.map(item => <button type="button" key={item.page} className={`${item.page === active?.page ? 'active' : ''} ${item.duplicate ? 'duplicate' : ''}`} onClick={() => setActivePage(item.page)}>
              <label onClick={event => event.stopPropagation()}><input type="checkbox" checked={item.include} onChange={event => updateItem(item.page, current => ({ ...current, include: event.target.checked }))}/><span><Check size={12}/></span></label>
              <div><b>Страница {item.page}</b><strong>{item.values.counterparty || 'Контрагент не распознан'}</strong><small>{item.values.amount ? money(item.values.amount) : 'Сумма не распознана'}</small>{item.duplicate && <em>Возможный дубль</em>}</div>
            </button>)}</div>
          </aside>
          {active && <main className="ai-scan-editor">
            <AIScanPreview batch={state.batch} page={active.page}/>
            <div className="ai-scan-form">
              <section className="ai-scan-recognized">
                <header><div><Sparkles size={18}/><span><strong>Извлечено из скана</strong><small>Обязательно проверьте перед сохранением</small></span></div><ConfidenceBadge item={active}/></header>
                <div className="ai-scan-fields">
                  <CustomSelect label="Контрагент" value={active.values.counterparty} options={references.counterparties} onChange={value => updateValue('counterparty', value)} allowCustom required/>
                  <ScanField label="Дата внесения" value={active.values.entry_date} readOnly/>
                  <CustomSelect label="Юридическое лицо" value={active.values.legal_entity} options={references.legal_entities} onChange={value => updateValue('legal_entity', value)} allowCustom required/>
                  <ScanField label="Сумма" type="number" step="0.01" min="0.01" value={active.values.amount ?? ''} onChange={value => updateValue('amount', value === '' ? null : Number(value))} required/>
                  <ScanField label="Документ" value={active.values.document_number} onChange={value => updateValue('document_number', value)} required/>
                  <ScanDateField label="Дата документа" value={active.values.document_date} onChange={value => updateValue('document_date', value)} required/>
                </div>
                {active.warnings.length > 0 && <div className="ai-scan-warnings">{active.warnings.map(warning => <span key={warning}><AlertTriangle size={13}/>{warning}</span>)}</div>}
              </section>
              <section className="ai-scan-manual">
                <header><FileSearch size={18}/><span><strong>Заполняет бухгалтер</strong><small>Эти значения намеренно не определяются по документу</small></span></header>
                <div className="ai-scan-fields">
                  <CustomSelect label="Признак учёта" value={active.values.account_type} options={references.account_types} onChange={value => updateValue('account_type', value)}/>
                  <CustomSelect label="Статья затрат" value={active.values.cost_category} options={references.cost_categories} onChange={value => updateValue('cost_category', value)}/>
                  <ScanField label="Отсрочка, дней" type="number" min="0" step="1" value={active.values.deferment_days ?? ''} onChange={value => updateValue('deferment_days', value === '' ? null : Number(value))}/>
                  <ScanDateField label="Плановая оплата" value={active.values.planned_payment_date} onChange={value => updateValue('planned_payment_date', value)}/>
                  <ScanDateField label="Дата утверждения" value={active.values.approval_date} onChange={value => updateValue('approval_date', value)}/>
                  <ScanDateField label="Фактическая оплата" value={active.values.actual_payment_date} onChange={value => updateValue('actual_payment_date', value)}/>
                  <CustomSelect label="Статус" value={active.values.status} options={references.statuses} onChange={value => updateValue('status', value)}/>
                  <CustomSelect label="Срочность" value={active.values.urgency} options={references.urgencies} onChange={value => updateValue('urgency', value)}/>
                  <CustomSelect label="Ответственный" value={active.values.responsible} options={references.responsibles} onChange={value => updateValue('responsible', value)} allowCustom/>
                  <CustomSelect label="Приоритет" value={active.values.priority} options={references.priorities} onChange={value => updateValue('priority', value)}/>
                  <ScanField label="Комментарий" value={active.values.comment} onChange={value => updateValue('comment', value)} wide/>
                  <ScanField label="Условия оплаты" value={active.values.source_note} onChange={value => updateValue('source_note', value)} wide/>
                </div>
              </section>
            </div>
          </main>}
        </div>}
      {!state.loading && !state.error && <footer className="modal-footer ai-scan-actions">
        <div>{missing.length ? <span className="error"><AlertTriangle size={15}/>Заполните обязательные поля: {missing.map(item => `стр. ${item.page} — ${item.field}`).join('; ')}</span> : <span><CheckCircle2 size={15}/>Перед записью выбрано {selected.length} из {items.length}</span>}</div>
        <button type="button" className="secondary" onClick={onClose} disabled={state.saving}>Отмена</button>
        <button type="button" className="primary" onClick={submit} disabled={!selected.length || missing.length > 0 || state.saving}>{state.saving ? <><LoaderCircle className="spin" size={16}/>Сохраняем…</> : `Добавить ${selected.length} в реестр`}</button>
      </footer>}
    </section>
  </div>
}

function requiredMissing(item) {
  const values = item.values
  return automaticFields.filter(([field]) => field !== 'entry_date' && (values[field] == null || values[field] === '' || (field === 'amount' && Number(values[field]) <= 0))).map(([, label]) => label)
}

function ConfidenceBadge({ item }) {
  const fields = ['counterparty', 'legal_entity', 'amount', 'document_number', 'document_date']
  const confident = fields.filter(field => item.confidence[field] === 'high').length
  return <span className={`ai-confidence ${confident === fields.length ? 'high' : confident >= 3 ? 'medium' : 'low'}`}>{confident}/{fields.length} уверенно</span>
}

function AIScanPreview({ batch, page }) {
  const [preview, setPreview] = useState({ loading: true, url: '', error: '' })
  useEffect(() => {
    let active = true
    let url = ''
    setPreview({ loading: true, url: '', error: '' })
    requestBlob(`/api/obligations/ai-scan/${batch}/${page}`).then(blob => {
      if (!active) return
      url = URL.createObjectURL(blob); setPreview({ loading: false, url, error: '' })
    }).catch(error => active && setPreview({ loading: false, url: '', error: error.message }))
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [batch, page])
  return <section className="ai-scan-preview">{preview.loading ? <LoaderCircle className="spin" size={28}/> : preview.error ? <AlertTriangle size={28}/> : <img src={preview.url} alt={`Страница ${page}`}/>}</section>
}

function ScanField({ label, value, onChange, wide, ...props }) {
  return <label className={`ai-scan-field ${wide ? 'wide' : ''}`}><span>{label}{props.required && <i>*</i>}</span><input value={value ?? ''} onChange={event => onChange?.(event.target.value)} {...props}/></label>
}

function ScanDateField({ label, value, onChange, required }) {
  return <label className="ai-scan-field"><span>{label}{required && <i>*</i>}</span><DateInput value={value || ''} onChange={onChange}/></label>
}

function optionValues(options = []) {
  return [...new Set(options.map(option => typeof option === 'string' ? option : option.value).filter(Boolean))]
}

function CustomSelect({ label, value, options, onChange, allowCustom, required }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const root = useRef(null)
  const values = useMemo(() => optionValues(options), [options])
  const visible = useMemo(() => { const term = search.trim().toLocaleLowerCase('ru-RU'); return term ? values.filter(item => item.toLocaleLowerCase('ru-RU').includes(term)) : values }, [search, values])
  useEffect(() => { const outside = event => !root.current?.contains(event.target) && setOpen(false); document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside) }, [])
  const choose = next => { onChange(next); setOpen(false); setSearch('') }
  const custom = search.trim() && !values.some(item => item.toLocaleLowerCase('ru-RU') === search.trim().toLocaleLowerCase('ru-RU'))
  return <label ref={root} className={`ai-scan-field ai-scan-select ${open ? 'open' : ''}`}><span>{label}{required && <i>*</i>}</span><button type="button" onClick={() => setOpen(current => !current)} aria-expanded={open}><b>{value || 'Не выбрано'}</b><ChevronDown size={15}/></button>{open && <div className="ai-scan-select-menu">
    <div><Search size={14}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск" autoFocus/></div>
    <section><button type="button" onClick={() => choose('')} className={!value ? 'selected' : ''}>Не выбрано{!value && <Check size={13}/>}</button>{allowCustom && custom && <button type="button" onClick={() => choose(search.trim())}>Использовать «{search.trim()}»</button>}{visible.map(option => <button type="button" key={option} onClick={() => choose(option)} className={option === value ? 'selected' : ''}>{option}{option === value && <Check size={13}/>}</button>)}</section>
  </div>}</label>
}
