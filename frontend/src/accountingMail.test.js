import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { ACCOUNTING_DESCRIPTION_LIMIT, ACCOUNTING_FILE_LIMIT, ACCOUNTING_SUBJECT_LIMIT, conversationsForSection, folderForAccountingConversation, validateAccountingMailDraft } from './accountingMail.js'

test('ordinary chats and accounting invoices never mix', () => {
  const items = [
    { id: 1, category: '', created_by: 7 },
    { id: 2, category: 'accounting', created_by: 7 },
    { id: 3, category: 'accounting', created_by: 9 },
  ]
  assert.deepEqual(conversationsForSection(items, 'chats', 'sent', 7).map(item => item.id), [1])
  assert.deepEqual(conversationsForSection(items, 'accounting', 'sent', 7).map(item => item.id), [2])
  assert.deepEqual(conversationsForSection(items, 'accounting', 'inbox', 7).map(item => item.id), [3])
  assert.equal(folderForAccountingConversation(items[2], 7, true), 'inbox')
  assert.equal(folderForAccountingConversation(items[2], 7, false), 'sent')
})

test('accounting invoice draft requires a supported file and validates mail fields', () => {
  const file = { name: 'Счёт.pdf', size: 1024 }
  assert.equal(validateAccountingMailDraft({ subject: 'Оплата счёта', description: '', file }), '')
  assert.match(validateAccountingMailDraft({ subject: '', description: '', file }), /тему/i)
  assert.match(validateAccountingMailDraft({ subject: 'x'.repeat(ACCOUNTING_SUBJECT_LIMIT + 1), description: '', file }), /120/)
  assert.match(validateAccountingMailDraft({ subject: 'Счёт', description: 'x'.repeat(ACCOUNTING_DESCRIPTION_LIMIT + 1), file }), new RegExp(String(ACCOUNTING_DESCRIPTION_LIMIT)))
  assert.match(validateAccountingMailDraft({ subject: 'Счёт', description: '', file: null }), /прикрепите/i)
  assert.match(validateAccountingMailDraft({ subject: 'Счёт', description: '', file: { name: 'Счёт.pdf', size: ACCOUNTING_FILE_LIMIT + 1 } }), /25 МБ/)
  assert.match(validateAccountingMailDraft({ subject: 'Счёт', description: '', file: { name: 'Счёт.exe', size: 1024 } }), /поддерживаются/i)
})

test('chat UI wires the accounting mailbox to multipart API', () => {
  const chat = fs.readFileSync(new URL('./Chat.jsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('./accountingMail.css', import.meta.url), 'utf8')
  assert.match(chat, /Чаты/)
  assert.match(chat, /Счета в бухгалтерию/)
  assert.match(chat, /invoice_mail\.inbox/)
  assert.match(chat, /invoice_mail\.send/)
  assert.match(chat, /\/api\/chat\/accounting\?subject=/)
  assert.match(chat, /payload\.append\('file'/)
  assert.match(chat, /onInitialConversationApplied\(\)/)
  assert.match(chat, /role="dialog" aria-modal="true"/)
  assert.match(styles, /\.accounting-mail-compose/)
  assert.match(styles, /html\[data-theme="dark"\] \.accounting-mail-compose/)
})
