import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('./ExecutiveDashboard.jsx', import.meta.url), 'utf8')

test('executive report uses its own landscape A4 page', () => {
  assert.match(styles, /@page executive-details\{size:A4 landscape;margin:10mm\}/)
  assert.match(styles, /\.executive-print-report\{[^}]*page:executive-details/)
  assert.match(styles, /@page payment-register\{size:A4 portrait;margin:10mm\}/)
})

test('print button is not collapsed by the generic modal button rule', () => {
  assert.match(dashboard, /className="secondary executive-print-button"/)
  assert.match(styles, /\.executive-detail-actions \.executive-print-button\{width:auto;height:40px;min-width:104px;/)
})
