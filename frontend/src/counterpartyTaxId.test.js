import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCounterparties, normalizeTaxIdInput, referenceOptionSearchText } from './counterpartyTaxId.js'

const counterparties = [
  { id: 1, value: 'ООО НОВАТЭК', tax_id: '7703727595' },
  { id: 2, value: 'ИП Кибирев О. А.', tax_id: '500100732259' },
  { id: 3, value: 'ООО Без ИНН', tax_id: '' },
]

test('counterparties are found by name and by INN', () => {
  assert.deepEqual(filterCounterparties(counterparties, 'новатэк').map(item => item.id), [1])
  assert.deepEqual(filterCounterparties(counterparties, '5001007').map(item => item.id), [2])
})

test('tax ID input is normalized without changing digits', () => {
  assert.equal(normalizeTaxIdInput(' 77-03 727595 '), '7703727595')
})

test('registry option search text includes the counterparty INN', () => {
  assert.equal(referenceOptionSearchText(counterparties[0]), 'ООО НОВАТЭК 7703727595')
})
