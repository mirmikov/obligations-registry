import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('print mode removes global banners and their reserved page offset', () => {
  assert.match(styles, /@media print\s*\{[\s\S]*?\.system-maintenance-banner,\.system-announcement-banner[\s\S]*?display:none!important/)
  assert.match(styles, /\.has-maintenance \.main,\.has-announcement \.main,\.has-maintenance\.has-announcement \.main\{padding-top:0!important\}/)
})
