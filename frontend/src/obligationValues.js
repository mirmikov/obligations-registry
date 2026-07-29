export function withDerivedObligationValues(values, changedField) {
  if (changedField === 'actual_payment_date' && values.actual_payment_date) {
    return { ...values, status: 'Оплачено' }
  }
  if (changedField !== 'deferment_days' && changedField !== 'document_date') return values
  if (!values.document_date || values.deferment_days == null || values.deferment_days === '') return values
  const date = new Date(`${values.document_date}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return values
  date.setUTCDate(date.getUTCDate() + Number(values.deferment_days))
  return { ...values, planned_payment_date: date.toISOString().slice(0, 10) }
}
