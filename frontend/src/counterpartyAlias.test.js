import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCounterparties, referenceOptionSearchText } from './counterpartyTaxId.js'

const counterparty = {
  id: 13328,
  value: 'ООО "Частное охранное предприятие "',
  tax_id: '4409085511',
  aliases: ['ЧОП СПАС'],
}

test('merged counterparty is found by its historical name', () => {
  assert.deepEqual(filterCounterparties([counterparty], 'чоп спас'), [counterparty])
})

test('registry option search includes historical counterparty names', () => {
  assert.match(referenceOptionSearchText(counterparty), /ЧОП СПАС/)
})
