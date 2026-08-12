export const paymentColumns = [
  { key: 'account_type', label: 'Признак учёта' },
  { key: 'legal_entity', label: 'Юрлицо', printLabel: 'Юридическое лицо' },
  { key: 'counterparty', label: 'Контрагент' },
  { key: 'document_number', label: 'Документ' },
  { key: 'planned_payment_date', label: 'Срок оплаты' },
  { key: 'amount', label: 'Сумма' },
]

export const paymentScreenColumns = [
  ...paymentColumns.map(column => ({ ...(column.key === 'planned_payment_date'
    ? { key: 'document_date', label: 'Дата документа' }
    : column), interactive: true })),
  { key: 'actual_payment_date', label: 'Фактическая дата оплаты', interactive: true },
  { key: 'status', label: 'Статус', interactive: true },
]

export function paymentUpdatePayload(item, field, value) {
  const { id, created_at, updated_at, overdue, due_soon, ...payload } = item
  const updated = { ...payload, [field]: value }
  if (field === 'actual_payment_date' && value) updated.status = 'Оплачено'
  return updated
}

export function localTodayISO(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
