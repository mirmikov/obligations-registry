import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAIScanObligationValues, formatAIScanDocumentPages, normalizeAIScanDocumentPages } from './aiScanValues.js'

test('AI scan uses recognized deferment instead of the counterparty default', () => {
  const values = buildAIScanObligationValues({
    counterparty: '', document_date: '', deferment_days: null, planned_payment_date: '', source_note: '', status: 'Зарегистрирован',
  }, {
    counterparty: 'ООО Поставщик', document_date: '2026-08-10', deferment_days: 15, payment_terms: 'Отсрочка 15 календарных дней',
  }, {}, { 'ООО Поставщик': 30 })
  assert.equal(values.deferment_days, 15)
  assert.equal(values.planned_payment_date, '2026-08-25')
  assert.equal(values.source_note, 'Отсрочка 15 календарных дней')
})

test('AI scan preserves the directory deferment when the document has no safe term', () => {
  const values = buildAIScanObligationValues({ counterparty: '', document_date: '2026-08-10', deferment_days: null, planned_payment_date: '', source_note: '' }, {
    counterparty: 'ООО Поставщик', document_date: '2026-08-10', deferment_days: null, payment_terms: '',
  }, {}, { 'ООО Поставщик': 30 })
  assert.equal(values.deferment_days, 30)
  assert.equal(values.planned_payment_date, '2026-09-09')
})

test('AI scan starts every recognized obligation as registered', () => {
  const values = buildAIScanObligationValues({ status: '' }, {
    counterparty: 'ООО Поставщик', legal_entity: 'ООО Покупатель', document_number: '17', document_date: '2026-09-01', amount: 1250,
  })
  assert.equal(values.status, 'Зарегистрирован')
})

test('AI scan normalizes and labels pages belonging to one invoice', () => {
  assert.deepEqual(normalizeAIScanDocumentPages({ page: 2, pages: [4, 2, 3, 3] }), [2, 3, 4])
  assert.equal(formatAIScanDocumentPages({ page: 2, pages: [2, 3, 4] }), 'Страницы 2–4')
  assert.equal(formatAIScanDocumentPages({ page: 7 }), 'Страница 7')
})
