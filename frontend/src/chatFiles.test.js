import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const chat = fs.readFileSync(new URL('./Chat.jsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('chat accepts file picker and drag and drop attachments', () => {
  assert.match(chat, /CHAT_FILE_ACCEPT.*\.pdf.*\.docx.*\.xlsx.*\.zip/)
  assert.match(chat, /onDrop=\{dropAttachment\}/)
  assert.match(chat, /Перетащите файл сюда/)
  assert.match(chat, /payload\.append\('file', draftAttachment\.file/)
  assert.match(styles, /\.chat-drop-zone/)
})

test('chat AI action is protected by the dedicated permission and uses confirmation modal', () => {
  assert.match(chat, /canAIScan = can\(user, 'registry\.ai_scan'\)/)
  assert.match(chat, /message\.ai_scannable && canAIScan/)
  assert.match(chat, /requestBlob\(message\.attachment_url\)/)
  assert.match(chat, /<AIScanModal.*onSave=\{saveChatAIScan\}/s)
})

test('chat attachment styles cover dark mode', () => {
  assert.match(styles, /html\[data-theme="dark"\] \.chat-file-card/)
})
