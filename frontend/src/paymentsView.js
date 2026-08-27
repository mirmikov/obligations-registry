export const paymentColumns = [
  { key: 'account_type', label: 'Признак учёта' },
  { key: 'legal_entity', label: 'Юрлицо', printLabel: 'Юридическое лицо' },
  { key: 'counterparty', label: 'Контрагент' },
  { key: 'document_number', label: 'Документ' },
  { key: 'planned_payment_date', label: 'Срок оплаты' },
  { key: 'amount', label: 'Сумма' },
]

const paymentScreenFilterTypes = {
  account_type: 'select',
  legal_entity: 'select',
  counterparty: 'multi-select',
  document_number: 'text',
  document_date: 'date',
  amount: 'amount',
  actual_payment_date: 'date',
  status: 'select',
}

export const paymentScreenColumns = [
  ...paymentColumns.map(column => ({ ...(column.key === 'planned_payment_date'
    ? { key: 'document_date', label: 'Дата документа' }
    : column), interactive: true })),
  { key: 'actual_payment_date', label: 'Фактическая дата оплаты', interactive: true },
  { key: 'status', label: 'Статус', interactive: true },
].map(column => ({ ...column, filter: paymentScreenFilterTypes[column.key] }))

export function buildPaymentRegisterQuery(filters = {}) {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, rawValue]) => {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    values.forEach(raw => {
      const value = String(raw ?? '').trim()
      if (value) params.append(key, value)
    })
  })
  return params.toString()
}

export function paymentUpdatePayload(item, field, value) {
  const { id, created_at, updated_at, overdue, due_soon, ...payload } = item
  const updated = { ...payload, [field]: value }
  if (field === 'actual_payment_date' && value) updated.status = 'Оплачено'
  return updated
}

export function paymentRowClassName(item) {
  if (item?.status === 'Оплачено' || item?.actual_payment_date) return 'payment-row paid'
  return `payment-row ${item?.urgency === 'Критическая' ? 'critical' : ''}`.trim()
}

export function localTodayISO(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
