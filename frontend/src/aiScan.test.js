import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const registry = fs.readFileSync(new URL('./Registry.jsx', import.meta.url), 'utf8')
const modal = fs.readFileSync(new URL('./AIScanModal.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('registry exposes AI scan only through create permission and accepts documents', () => {
  assert.match(registry, /can\(user, 'registry\.create'\).*AI сканирование/s)
  assert.match(registry, /accept="application\/pdf,image\/png,image\/jpeg"/)
  assert.match(registry, /request\('\/api\/obligations\/ai-scan'/)
  assert.match(registry, /result\.status === 'processing'.*\/api\/obligations\/ai-scan\/\$\{result\.batch\}\/status/s)
})

test('AI scan keeps recognized and accountant fields separate', () => {
  for (const label of ['Контрагент', 'Дата внесения', 'Юридическое лицо', 'Сумма', 'Документ', 'Дата документа']) assert.match(modal, new RegExp(label))
  for (const label of ['Признак учёта', 'Статья затрат', 'Отсрочка, дней', 'Плановая оплата', 'Дата утверждения', 'Фактическая оплата', 'Статус', 'Срочность', 'Ответственный', 'Приоритет', 'Комментарий']) assert.match(modal, new RegExp(label))
  assert.match(registry, /\.\.\.blankObligation\(\), status: ''/)
})

test('multi-page scan supports preview, duplicate protection and confirmed batch commit', () => {
  assert.match(modal, /item\.duplicate.*Возможный дубль/s)
  assert.match(modal, /AIScanPreview batch=\{state\.batch\} page=\{active\.page\}/)
  assert.match(registry, /\/api\/obligations\/ai-scan\/\$\{aiScan\.batch\}\/commit/)
  assert.match(styles, /\.ai-scan-layout\{[^}]*grid-template-columns:300px minmax\(0,1fr\)/)
  assert.match(styles, /html\[data-theme="dark"\] \.ai-scan-layout/)
})

test('confirmed AI scan refreshes counterparties created in the reference directory', () => {
  assert.match(registry, /created_references/)
  assert.match(registry, /request\('\/api\/references'\)\.then\(setRefs\)/)
})
