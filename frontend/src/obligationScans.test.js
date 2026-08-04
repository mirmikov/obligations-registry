import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('registry selection cell is split into selection and scan controls', () => {
  assert.match(registry, /className="registry-row-controls"/)
  assert.match(registry, /className="registry-row-selector"/)
  assert.match(registry, /<ObligationScanControl item=\{item\}/)
  assert.match(styles, /\.registry-row-controls\{[^}]*grid-template-rows:32px 1fr/)
})

test('scan control uploads, views, replaces and deletes a document', () => {
  assert.match(registry, /form\.append\('scan', file\)/)
  assert.match(registry, /requestBlob\(`\/api\/obligations\/\$\{item\.id\}\/scan`\)/)
  assert.match(registry, /Загрузить новый/)
  assert.match(registry, /Подтвердить удаление/)
  assert.match(registry, /accept="application\/pdf,image\/png,image\/jpeg,image\/webp"/)
})

test('scan control follows registry edit permissions', () => {
  assert.match(registry, /editable=\{can\(user, 'registry\.edit'\)\}/)
  assert.match(registry, /\(!editable && !item\.has_scan\)/)
  assert.match(registry, /\{editable && <>/)
})
