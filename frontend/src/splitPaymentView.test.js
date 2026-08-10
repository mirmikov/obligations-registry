import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('fixed amount split is a fully manual list without period or automatic amount fields', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

  assert.match(source, /Ручной график платежей/)
  assert.match(source, /Добавить платёж/)
  assert.match(source, /aria-label={`Сумма платежа \$\{index \+ 1\}`}/)
  assert.match(source, /amount_parts: \[\{ amount: '', account_type: '', planned_date: '' \}\]/)
  assert.doesNotMatch(source, /payment_amount|payment_account_types|fixedAmountPaymentCount/)
  assert.doesNotMatch(source, /period_unit|period_value|Дата первого платежа|Повторять каждые|<span>Период<\/span>/)
})

test('manual payment rows can be added, removed and filled independently', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')

  assert.match(source, /amount_parts: \[\.\.\.current\.amount_parts, \{ amount: '', account_type: '', planned_date: '' \}\]/)
  assert.match(source, /current\.amount_parts\.filter\(\(_, partIndex\) => partIndex !== index\)/)
  assert.match(source, /aria-label={`Признак учёта платежа \$\{index \+ 1\}`}/)
  assert.match(source, /aria-label={`Плановая дата платежа \$\{index \+ 1\}`}/)
  assert.match(source, /amount_parts: form\.mode === 'amount' \? form\.amount_parts\.map/)
})

test('manual fixed amounts require two rows, exact total, dates and OMS or Commercial', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const preview = source.slice(source.indexOf('function buildSplitPreview'), source.indexOf('function formatPercent'))

  assert.match(preview, /parts\.length < 2 \|\| parts\.length > 60/)
  assert.match(preview, /\['ОМС', 'Коммерция'\]\.includes\(parts\[index\]\.account_type\)/)
  assert.match(preview, /parts\[index\]\.planned_date/)
  assert.match(preview, /amountTotalCents !== totalCents/)
  assert.match(preview, /До общей суммы не хватает/)
  assert.match(preview, /Сумма графика превышает исходную/)
})

test('manual amount editor has responsive row styling', () => {
  const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

  assert.match(styles, /\.split-amount-row\{grid-template-columns:/)
  assert.match(styles, /@media\(max-width:760px\)\{\.split-amount-row/)
})
