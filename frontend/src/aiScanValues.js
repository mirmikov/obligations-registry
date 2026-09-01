import { withReferenceDefaults } from './referenceDefaults.js'

export function buildAIScanObligationValues(blank, item, responsibleByCostCategory = {}, defermentByCounterparty = {}) {
  let values = withReferenceDefaults({
    ...blank,
    status: 'Зарегистрирован',
    counterparty: item.counterparty || '',
    legal_entity: item.legal_entity || '',
    document_number: item.document_number || '',
    document_date: item.document_date || '',
    amount: item.amount ?? null,
  }, 'counterparty', responsibleByCostCategory, defermentByCounterparty)
  if (item.deferment_days != null) {
    values = withReferenceDefaults({ ...values, deferment_days: Number(item.deferment_days) }, 'deferment_days', responsibleByCostCategory, defermentByCounterparty)
  }
  return { ...values, source_note: item.payment_terms || values.source_note || '' }
}

export function normalizeAIScanDocumentPages(item) {
  const pages = Array.isArray(item?.pages) ? item.pages.map(Number).filter(page => Number.isInteger(page) && page > 0) : []
  return pages.length ? [...new Set(pages)].sort((left, right) => left - right) : [Number(item?.page) || 1]
}

export function formatAIScanDocumentPages(item) {
  const pages = normalizeAIScanDocumentPages(item)
  return pages.length === 1 ? `Страница ${pages[0]}` : `Страницы ${pages[0]}–${pages[pages.length - 1]}`
}
