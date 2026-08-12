import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const dashboard = readFileSync(new URL('./ExecutiveDashboard.jsx', import.meta.url), 'utf8')

test('executive Kibirev rent section renders a separate summary and admin settings control', () => {
  assert.match(dashboard, /Аренда — ИП Кибирев О\. А\./)
  assert.match(dashboard, /Настройки панели руководителя/)
  assert.match(dashboard, /role="switch"/)
  assert.match(dashboard, /\/api\/reports\/executive\/settings/)
})

test('executive Kibirev rent section loads specialized details and exposes only payable status', () => {
  assert.match(dashboard, /\/api\/reports\/executive\/special-details/)
  assert.match(dashboard, /details\.kind === 'special'/)
  assert.match(dashboard, /\? \['К оплате'\]/)
  for (const heading of ['Счёт', 'Оплачено', 'Остаток', 'Дата утверждения']) {
    assert.ok(dashboard.includes(`<th>${heading}</th>`), `missing heading ${heading}`)
  }
})

test('executive Kibirev rent section refreshes the dashboard and active details after an approval change', () => {
  assert.match(dashboard, /request\('\/api\/reports\/executive\/obligations\/bulk'/)
  assert.match(dashboard, /optimisticItem = withDerivedObligationValues\(\{ \.\.\.item, \[field\]: value \}, field\)/)
  assert.match(dashboard, /row\.id === item\.id \? optimisticItem : row/)
  assert.match(dashboard, /Promise\.all\(\[/)
  assert.match(dashboard, /setData\(dashboardResult\)/)
})
