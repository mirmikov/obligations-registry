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
  assert.match(registry, /scanURL = `\/api\/obligations\/\$\{item\.id\}\/scan`/)
  assert.match(registry, /requestBlob\(scanURL\)/)
  assert.match(registry, /Заменить файл/)
  assert.match(registry, /Нажмите ещё раз для удаления/)
  assert.match(registry, /Печать без сжатия/)
  assert.match(registry, /printOriginalScan\(\{/)
  assert.match(registry, /<iframe src=\{preview\.url\}/)
  assert.match(registry, /createPortal\(<div className="modal-backdrop scan-modal-backdrop"/)
  assert.match(registry, /accept="application\/pdf,image\/png,image\/jpeg,image\/webp"/)
})

test('scan modal is adaptive and cannot be clipped by the table cell', () => {
  assert.match(registry, /document\.body\)/)
  assert.match(styles, /\.scan-document-modal\{[^}]*height:min\(820px/)
  assert.match(styles, /\.scan-document-preview iframe,\.scan-document-preview img/)
  assert.match(styles, /\.scan-print-frame\{[^}]*left:-10000px/)
  assert.match(styles, /@media\(max-width:760px\).*\.scan-document-layout\{grid-template-columns:1fr/s)
})

test('scan control follows registry edit permissions', () => {
  assert.match(registry, /editable=\{can\(user, 'registry\.edit'\)\}/)
  assert.match(registry, /\(!editable && !item\.has_scan\)/)
  assert.match(registry, /\{editable && <>/)
})
