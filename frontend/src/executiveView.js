import { PAYABLE_STATUS } from './obligationValues.js'

export const EXECUTIVE_FILTER_STATUSES = ['К оплате', 'Зарегистрирован']

export function defaultExecutiveFilters(today) {
  return { as_of: today, legal_entity: '', account_type: '', status: '' }
}

export function executiveUpdatePayload(id, field, value) {
  const payload = { ids: [id], status: '', approval_date: '', actual_payment_date: '' }
  if (field === 'status') payload.status = value
  else if (field === 'approval_date') {
    payload.approval_date = value
    payload.approval_date_set = true
    if (value) payload.status = PAYABLE_STATUS
  } else {
    throw new Error(`Unsupported executive field: ${field}`)
  }
  return payload
}
