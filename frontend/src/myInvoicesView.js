export function filterMyInvoices(items = [], filters = {}) {
  const query = normalize(filters.query)
  return items.filter(item => {
    if (filters.status && item.status !== filters.status) return false
    if (filters.legalEntity && item.legal_entity !== filters.legalEntity) return false
    if (filters.dateFrom && (!item.planned_payment_date || item.planned_payment_date < filters.dateFrom)) return false
    if (filters.dateTo && (!item.planned_payment_date || item.planned_payment_date > filters.dateTo)) return false
    if (!query) return true
    return [item.counterparty, item.document_number, item.legal_entity, item.cost_category, item.responsible, item.comment, item.source_note, item.status]
      .some(value => normalize(value).includes(query))
  })
}

export function summarizeMyInvoices(items = [], today = todayISO()) {
  return items.reduce((result, item) => {
    const amount = Number(item.amount || 0)
    const status = normalize(item.status)
    result.count += 1
    result.amount += amount
    if (status === normalize('К оплате')) {
      result.payableCount += 1
      result.payableAmount += amount
    }
    if (status === normalize('Зарегистрирован') || status === normalize('Зарегистрировано')) {
      result.registeredCount += 1
      result.registeredAmount += amount
    }
    if (item.actual_payment_date || status === normalize('Оплачено')) {
      result.paidCount += 1
      result.paidAmount += amount
    }
    if (item.planned_payment_date && item.planned_payment_date < today && !item.actual_payment_date && status !== normalize('Оплачено') && status !== normalize('Отменено')) {
      result.overdueCount += 1
      result.overdueAmount += amount
    }
    return result
  }, {
    count: 0, amount: 0,
    registeredCount: 0, registeredAmount: 0,
    payableCount: 0, payableAmount: 0,
    paidCount: 0, paidAmount: 0,
    overdueCount: 0, overdueAmount: 0,
  })
}

export function uniqueInvoiceValues(items = [], field) {
  return [...new Set(items.map(item => String(item[field] || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'ru'))
}

function normalize(value) { return String(value || '').trim().toLocaleLowerCase('ru-RU') }
function todayISO() { const date = new Date(); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }

