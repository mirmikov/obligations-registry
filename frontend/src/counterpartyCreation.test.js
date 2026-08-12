import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartyCreationSeed, normalizedCounterpartyOptions } from './counterpartyCreation.js'

test('counterparty creation opens manual mode with the entered name', () => {
  assert.deepEqual(counterpartyCreationSeed('  ООО «Новый поставщик»  '), {
    value: 'ООО «Новый поставщик»', taxID: '', mode: 'manual',
  })
})

test('counterparty creation opens FNS mode with a full or partial entered INN', () => {
  assert.deepEqual(counterpartyCreationSeed('77 07-083893'), {
    value: '', taxID: '7707083893', mode: 'fns',
  })
  assert.deepEqual(counterpartyCreationSeed('5001-007'), {
    value: '', taxID: '5001007', mode: 'fns',
  })
})

test('counterparty choices are searchable by name and INN without duplicates', () => {
  assert.deepEqual(normalizedCounterpartyOptions([
    { value: 'ООО Ромашка', tax_id: '7707083893' },
    { value: 'ООО Ромашка', tax_id: '0000000000' },
    'ИП Иванов',
  ]), [
    { value: 'ООО Ромашка', taxID: '7707083893', searchText: 'ооо ромашка 7707083893' },
    { value: 'ИП Иванов', taxID: '', searchText: 'ип иванов' },
  ])
})
