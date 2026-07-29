import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

const finalZIndexFor = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...styles.matchAll(new RegExp(`${escaped}\\{[^}]*z-index:(\\d+)`, 'g'))]
  assert.ok(matches.length, `Expected ${selector} to define a numeric z-index`)
  return Number(matches.at(-1)[1])
}

test('calendar is rendered above the executive details modal', () => {
  assert.ok(
    finalZIndexFor('.custom-calendar') > finalZIndexFor('.executive-detail-backdrop'),
    'The portalled calendar must stay above the executive details backdrop',
  )
})
