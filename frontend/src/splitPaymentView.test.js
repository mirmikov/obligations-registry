import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('fixed amount split has no period controls and uses manual schedule fields', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const settings = source.slice(source.indexOf("form.mode === 'count' ? <>"), source.indexOf('</>}', source.indexOf("form.mode === 'count' ? <>")) + 4)
  const equalParts = settings.slice(0, settings.indexOf('</> : <>'))
  const fixedAmount = settings.slice(settings.indexOf('</> : <>'))

  assert.match(equalParts, /Количество платежей/)
  assert.doesNotMatch(equalParts, /Плановая дата платежей/)
  assert.doesNotMatch(equalParts, /Повторять каждые|<span>Период<\/span>/)
  assert.match(fixedAmount, /Сумма одного платежа/)
  assert.doesNotMatch(fixedAmount, /Дата первого платежа|Повторять каждые|<span>Период<\/span>/)
  assert.doesNotMatch(source, /period_unit|period_value|splitDate/)
})

test('equal and fixed amount previews use individually editable dates', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const preview = source.slice(source.indexOf('function buildSplitPreview'), source.indexOf('function formatPercent'))

  assert.match(preview, /form\.payment_dates\.length !== count/)
  assert.match(preview, /date: form\.payment_dates\[index\]/)
  assert.match(source, /aria-label={`Плановая дата платежа \$\{part\.number\}`}/)
  assert.match(source, /form\.mode !== 'percentage' \? <DateInput/)
  assert.match(source, /payment_dates: form\.mode === 'percentage' \? null : form\.payment_dates/)
})

test('fixed amount preview requires OMS or Commercial for every payment', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const preview = source.slice(source.indexOf('function buildSplitPreview'), source.indexOf('function formatPercent'))

  assert.match(source, /fixedAmountAccountTypes = \['ОМС', 'Коммерция'\]/)
  assert.match(source, /aria-label={`Признак учёта платежа \$\{part\.number\}`}/)
  assert.match(preview, /form\.payment_account_types\.length !== amounts\.length/)
  assert.match(preview, /\['ОМС', 'Коммерция'\]\.includes\(value\)/)
  assert.match(source, /payment_account_types: form\.mode === 'amount' \? form\.payment_account_types : null/)
})
