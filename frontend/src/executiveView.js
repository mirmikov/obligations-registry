export const EXECUTIVE_FILTER_STATUSES = ['Зарегистрирован', 'К оплате']

export function defaultExecutiveFilters(today) {
  return { as_of: today, legal_entity: '', account_type: '', status: EXECUTIVE_FILTER_STATUSES[0] }
}

export function executiveUpdatePayload(id, field, value) {
  const payload = { ids: [id], status: '', approval_date: '', actual_payment_date: '' }
  if (field === 'status') payload.status = value
  else if (field === 'approval_date') {
    payload.approval_date = value
    payload.approval_date_set = true
  } else {
    throw new Error(`Unsupported executive field: ${field}`)
  }
  return payload
}
