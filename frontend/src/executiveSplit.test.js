import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync(new URL('./ExecutiveDashboard.jsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('executive dashboard reuses the registry split modal and its eligibility rules', () => {
  assert.match(registry, /export function SplitPaymentModal/)
  assert.match(registry, /export function canSplitPayment/)
  assert.match(dashboard, /import \{ canSplitPayment, SplitPaymentModal \} from '\.\/Registry'/)
  assert.match(dashboard, /can\(user, 'registry\.split'\)/)
  assert.match(dashboard, /<SplitPaymentModal item=\{splitItem\}/)
  assert.match(dashboard, /\/api\/obligations\/\$\{item\.id\}\/split/)
})

test('executive split refreshes both the dashboard and the active details', () => {
  assert.match(dashboard, /const \[dashboardResult, detailsResult\] = await Promise\.all/)
  assert.match(dashboard, /setData\(dashboardResult\)/)
  assert.match(dashboard, /setDetails\(current => current \? \{ \.\.\.current, \.\.\.detailsResult \} : current\)/)
  assert.match(dashboard, /result\.installments\.length/)
})

test('both executive detail tables show account type and split actions', () => {
  assert.equal(dashboard.match(/<th>Признак учёта<\/th>/g)?.length, 2)
  assert.equal(dashboard.match(/\{item\.account_type \|\| '—'\}/g)?.length, 2)
  assert.match(dashboard, /function ExecutiveSplitCell/)
  assert.match(dashboard, /<Scissors size=\{14\}\/>Разбить/)
})

test('executive split action stays compact in the scrollable details table', () => {
  assert.match(styles, /\.executive-detail-action\{width:108px;/)
  assert.match(styles, /\.executive-split-button\{width:auto;min-width:88px;height:34px;/)
})
