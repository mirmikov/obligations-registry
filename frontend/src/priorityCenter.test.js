import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('./PriorityCenter.jsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./priorityCenter.css', import.meta.url), 'utf8')
const registry = readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const payments = readFileSync(new URL('./Payments.jsx', import.meta.url), 'utf8')
const scan = readFileSync(new URL('./AIScanModal.jsx', import.meta.url), 'utf8')

test('priority center is a protected child page of registry', () => {
  assert.match(app, /id: 'priority-center'.*permission: 'priority_center\.view'/)
  assert.match(app, /<PriorityCenter/)
  assert.match(page, /\/api\/reports\/priority-center/)
})

test('priority center provides custom filters, matrix and detailed queue', () => {
  assert.match(page, /function PrioritySelect/)
  assert.match(page, /Срочность/)
  assert.match(page, /Важность/)
  assert.match(page, /selectMatrix/)
  assert.match(page, /priority-table-card/)
  assert.match(styles, /html\[data-theme="dark"\] \.priority-center-page/)
})

test('approval controls are role-gated in every editable registry surface', () => {
  assert.match(registry, /canApproveObligations\(user\)/)
  assert.match(registry, /approvalStatusOptions\(refs\.statuses, approvalEditable\)/)
  assert.match(payments, /approvalStatusOptions\(refs\.statuses, approvalEditable\)/)
  assert.match(scan, /approvalStatusOptions\(references\.statuses, approvalEditable\)/)
  assert.match(scan, /Только руководитель или программист/)
})
