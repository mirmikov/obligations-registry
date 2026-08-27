import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { DateHeaderFilter, HeaderFilter } from './Registry'

export function paymentFilterActive(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

export default function PaymentColumnFilter({ column, value, refs, onChange }) {
  let control = null
  if (column.filter === 'select' || column.filter === 'multi-select') {
    control = <HeaderFilter
      label={column.label}
      value={value}
      options={paymentFilterOptions(refs, column.key)}
      onChange={onChange}
      multiple={column.filter === 'multi-select'}
      allowBlank={column.key === 'account_type'}
    />
  } else if (column.filter === 'date') {
    control = <DateHeaderFilter label={column.label} value={value || ''} onChange={onChange}/>
  } else if (column.filter === 'text' || column.filter === 'amount') {
    control = <PaymentTextHeaderFilter label={column.label} value={value || ''} onChange={onChange} amount={column.filter === 'amount'}/>
  }
  return <><b>{column.label}</b>{control}</>
}

function paymentFilterOptions(refs, key) {
  return ({
    account_type: refs.account_types,
    legal_entity: refs.legal_entities,
    counterparty: refs.counterparties,
    status: refs.statuses,
  }[key] || [])
}

function PaymentTextHeaderFilter({ label, value, onChange, amount = false }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])
  const toggle = () => {
    if (!open) setDraft(value)
    setOpen(current => !current)
  }
  const apply = () => {
    onChange(draft.trim())
    setOpen(false)
  }
  const clear = () => {
    setDraft('')
    onChange('')
    setOpen(false)
  }
  const keyDown = event => {
    if (event.key === 'Enter') { event.preventDefault(); apply() }
  }
  return <div ref={rootRef} className={`header-filter payment-text-header-filter ${open ? 'is-open' : ''} ${value ? 'has-value' : ''}`}>
    <button type="button" className="header-filter-trigger" aria-label={`Фильтр: ${label}`} aria-expanded={open} onClick={toggle}><Search size={13}/>{value && <i/>}</button>
    {open && <div className="header-filter-menu payment-text-filter-menu">
      <div className="header-filter-search"><Search size={15}/><input ref={inputRef} value={draft} inputMode={amount ? 'decimal' : 'search'} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={amount ? 'Введите точную сумму' : 'Введите часть номера'} aria-label={`Значение фильтра: ${label}`}/>{draft && <button type="button" onClick={() => setDraft('')} aria-label="Очистить поле"><X size={13}/></button>}</div>
      <div className="payment-text-filter-actions"><button type="button" className="secondary" onClick={clear}>Сбросить</button><button type="button" className="primary" onClick={apply}>Применить</button></div>
    </div>}
  </div>
}
