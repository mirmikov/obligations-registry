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

test('attachment preview never scrolls the message input out of view', () => {
  assert.match(chat, /draftAttachment \? 'has-attachment'/)
  assert.match(styles, /\.chat-composer\.has-attachment\{[^}]*grid-template-rows:auto auto/)
  assert.match(styles, /\.chat-page-compact \.chat-composer[^}]*max-height:none;overflow:visible/)
  assert.match(styles, /\.chat-composer-main\{[^}]*min-height:38px;flex:0 0 auto/)
})

test('long chats keep the composer inside the viewport', () => {
  assert.match(styles, /\.chat-page:not\(\.chat-page-compact\)\{[^}]*grid-template-rows:minmax\(0,1fr\)/)
  assert.match(styles, /\.chat-page>\.chat-list-panel,\.chat-page>\.chat-room\{[^}]*min-height:0;overflow:hidden/)
  assert.match(styles, /\.has-maintenance \.chat-page:not\(\.chat-page-compact\)\{height:calc\(100dvh - 38px\)/)
})
