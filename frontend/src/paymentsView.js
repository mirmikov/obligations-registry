export const paymentColumns = [
  { key: 'account_type', label: 'Признак учёта' },
  { key: 'legal_entity', label: 'Юрлицо', printLabel: 'Юридическое лицо' },
  { key: 'counterparty', label: 'Контрагент' },
  { key: 'document_number', label: 'Документ' },
  { key: 'planned_payment_date', label: 'Срок оплаты' },
  { key: 'amount', label: 'Сумма' },
]

export function localTodayISO(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
