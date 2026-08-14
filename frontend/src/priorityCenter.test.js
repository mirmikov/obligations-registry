import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('./PriorityCenter.jsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./priorityCenter.css', import.meta.url), 'utf8')
const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const payments = readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
const scan = readFileSync(new URL('./AIScanModal.jsx', import.meta.url), 'utf8')

test('urgent payments is a protected child page of registry', () => {
  assert.match(app, /id: 'priority-center'.*permission: 'priority_center\.view'/)
  assert.match(app, /<PriorityCenter[^>]*user=\{user\}/)
  assert.match(page, /\/api\/reports\/priority-center/)
})

test('manager can approve one or many urgent payments with an explicit date', () => {
  assert.match(page, /priority_center\.approve/)
  assert.match(page, /canApproveObligations\(user\)/)
  assert.match(page, /\/api\/reports\/priority-center\/approve/)
  assert.match(page, /ids, approval_date: approvalDate/)
  assert.match(page, /Выбранные — к оплате/)
  assert.match(page, /approve\(\[item\.id\]\)/)
})

test('urgent queue provides focused filters, summaries and dark responsive styles', () => {
  assert.match(page, /Требуют внимания/)
  assert.match(page, /Просрочены/)
  assert.match(page, /function PrioritySelect/)
  assert.match(page, /urgent-table-card/)
  assert.match(styles, /html\[data-theme="dark"\] \.priority-center-page/)
  assert.match(styles, /@media\(max-width:680px\)/)
})

test('approval controls remain role-gated in every editable registry surface', () => {
  assert.match(registry, /canApproveObligations\(user\)/)
  assert.match(registry, /approvalStatusOptions\(refs\.statuses, approvalEditable\)/)
  assert.match(payments, /approvalStatusOptions\(refs\.statuses, approvalEditable\)/)
  assert.match(scan, /approvalStatusOptions\(references\.statuses, approvalEditable\)/)
})
