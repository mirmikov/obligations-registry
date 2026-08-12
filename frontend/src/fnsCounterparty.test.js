import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fnsEntityLabel, formatFNSDate, safeFNSSourceURL, validateFNSTaxID } from './fnsCounterparty.js'

test('FNS lookup accepts valid organization and entrepreneur INNs', () => {
  assert.deepEqual(validateFNSTaxID('77 07-083893'), {
    taxID: '7707083893', complete: true, valid: true, entityType: 'legal_entity', error: '',
  })
  assert.deepEqual(validateFNSTaxID('500100732259'), {
    taxID: '500100732259', complete: true, valid: true, entityType: 'individual_entrepreneur', error: '',
  })
})

test('FNS lookup does not start for partial INN and rejects wrong checksum', () => {
  assert.equal(validateFNSTaxID('7707').complete, false)
  assert.equal(validateFNSTaxID('7707083894').valid, false)
  assert.match(validateFNSTaxID('7707083894').error, /контрольные цифры/i)
})

test('FNS presentation helpers format official data safely', () => {
  assert.equal(fnsEntityLabel('individual_entrepreneur'), 'Индивидуальный предприниматель')
  assert.equal(fnsEntityLabel('legal_entity'), 'Организация')
  assert.equal(formatFNSDate('2026-08-07'), '07.08.2026')
  assert.match(safeFNSSourceURL('https://pb.nalog.ru/search.html#queryAll=7707083893'), /^https:\/\/pb\.nalog\.ru\//)
  assert.equal(safeFNSSourceURL('https://evil.example/search'), '')
})

test('FNS autofill is limited to new counterparties and existing cards are read-only', () => {
  const source = readFileSync(new URL('./References.jsx', import.meta.url), 'utf8')
  assert.match(source, /new_only:\s*true/)
  assert.match(source, /Уже заведённые записи не изменяются/)
  assert.match(source, /Только просмотр: сведения ФНС не перезаписывают существующего контрагента/)
  assert.match(source, /GET|request\(`\/api\/references\/counterparties\/\$\{id\}\/fns`\)/)
})
