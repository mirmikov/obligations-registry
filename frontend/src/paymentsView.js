export const paymentColumns = [
  { key: 'account_type', label: 'Признак учёта' },
  { key: 'legal_entity', label: 'Юрлицо', printLabel: 'Юридическое лицо' },
  { key: 'counterparty', label: 'Контрагент' },
  { key: 'document_number', label: 'Документ' },
  { key: 'planned_payment_date', label: 'Срок оплаты' },
  { key: 'amount', label: 'Сумма' },
]

export const paymentScreenColumns = [
  ...paymentColumns.map(column => column.key === 'planned_payment_date'
    ? { key: 'document_date', label: 'Дата документа' }
    : column),
  { key: 'actual_payment_date', label: 'Фактическая дата оплаты', interactive: true },
  { key: 'status', label: 'Статус', interactive: true },
]

export const paymentEditableColumns = [
  { key: 'counterparty', label: 'Контрагент', width: 220 },
  { key: 'entry_date', label: 'Дата внесения', width: 130 },
  { key: 'account_type', label: 'Признак', width: 130 },
  { key: 'legal_entity', label: 'Юрлицо', width: 180 },
  { key: 'amount', label: 'Сумма', width: 120 },
  { key: 'document_number', label: 'Документ', width: 180 },
  { key: 'document_date', label: 'Дата документа', width: 135 },
  { key: 'cost_category', label: 'Статья затрат', width: 240 },
  { key: 'deferment_days', label: 'Отсрочка, дней', width: 110 },
  { key: 'planned_payment_date', label: 'Плановая оплата', width: 145 },
  { key: 'approval_date', label: 'Дата утверждения', width: 145 },
  { key: 'actual_payment_date', label: 'Фактическая оплата', width: 145 },
  { key: 'status', label: 'Статус', width: 160 },
  { key: 'urgency', label: 'Срочность', width: 135 },
  { key: 'responsible', label: 'Ответственный', width: 160 },
  { key: 'priority', label: 'Приоритет', width: 120 },
  { key: 'comment', label: 'Комментарий', width: 240 },
  { key: 'source_note', label: 'Условия оплаты', width: 240 },
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
