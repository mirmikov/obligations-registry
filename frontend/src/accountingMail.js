export const ACCOUNTING_SECTION = 'accounting'
export const ACCOUNTING_SUBJECT_LIMIT = 120
// The message column also stores a compact attachment marker. Keeping this
// below 2800 guarantees that even a maximum-length Unicode filename fits.
export const ACCOUNTING_DESCRIPTION_LIMIT = 2800
export const ACCOUNTING_FILE_LIMIT = 25 * 1024 * 1024
export const ACCOUNTING_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.csv,.txt,.zip'

export function isAccountingConversation(conversation) {
  return conversation?.category === 'accounting'
}

export function conversationsForSection(conversations, section, folder, userID) {
  if (section !== ACCOUNTING_SECTION) return conversations.filter(item => !isAccountingConversation(item))
  return conversations.filter(item => {
    if (!isAccountingConversation(item)) return false
    const sentByUser = String(item.created_by) === String(userID)
    return folder === 'sent' ? sentByUser : !sentByUser
  })
}

export function folderForAccountingConversation(conversation, userID, canOpenInbox) {
  if (!isAccountingConversation(conversation)) return 'sent'
  return canOpenInbox && String(conversation.created_by) !== String(userID) ? 'inbox' : 'sent'
}

export function validateAccountingMailDraft({ subject, description, file }) {
  const trimmedSubject = String(subject || '').trim()
  if (!trimmedSubject) return 'Укажите тему счёта'
  if ([...trimmedSubject].length > ACCOUNTING_SUBJECT_LIMIT) return `Тема должна быть не длиннее ${ACCOUNTING_SUBJECT_LIMIT} символов`
  if ([...String(description || '').trim()].length > ACCOUNTING_DESCRIPTION_LIMIT) return `Описание должно быть не длиннее ${ACCOUNTING_DESCRIPTION_LIMIT} символов`
  if (!file) return 'Прикрепите файл счёта'
  if (!Number.isFinite(file.size) || file.size <= 0) return 'Файл счёта пуст'
  if (file.size > ACCOUNTING_FILE_LIMIT) return 'Файл счёта должен быть не больше 25 МБ'
  const extension = `.${String(file.name || '').split('.').pop()?.toLowerCase()}`
  if (!ACCOUNTING_FILE_ACCEPT.split(',').includes(extension)) return 'Поддерживаются PDF, изображения, DOCX, XLSX, CSV, TXT и ZIP'
  return ''
}
