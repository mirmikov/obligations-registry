import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('period controls remain only in the fixed amount branch', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const settings = source.slice(source.indexOf("form.mode === 'count' ? <>"), source.indexOf('</>}', source.indexOf("form.mode === 'count' ? <>")) + 4)
  const equalParts = settings.slice(0, settings.indexOf('</> : <>'))

  assert.match(equalParts, /Плановая дата платежей/)
  assert.doesNotMatch(equalParts, /Повторять каждые|<span>Период<\/span>/)
})

test('equal payment preview uses one shared date without period validation', () => {
  const source = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
  const preview = source.slice(source.indexOf('function buildSplitPreview'), source.indexOf('function formatPercent'))

  assert.match(preview, /form\.mode === 'amount' && \(!Number\.isInteger\(interval\)/)
  assert.match(preview, /date: form\.mode === 'count' \? form\.start_date : splitDate/)
})
