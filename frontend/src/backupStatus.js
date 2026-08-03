export function backupStatusPresentation(status) {
  if (!status) return { tone: 'pending', title: 'Проверяем бэкап', subtitle: 'Расписание 18:00 МСК' }
  if (status.state === 'completed') return { tone: 'success', title: 'Бэкап выполнен', subtitle: status.version ? `Версия ${status.version}` : 'Копия проверена' }
  if (status.state === 'failed') return { tone: 'error', title: 'Ошибка бэкапа', subtitle: 'Требуется проверка' }
  if (status.state === 'overdue') return { tone: 'error', title: 'Бэкап не выполнен', subtitle: 'Запуск в 18:00 пропущен' }
  if (status.state === 'unavailable') return { tone: 'error', title: 'Статус недоступен', subtitle: 'Проверьте службу' }
  return { tone: 'pending', title: 'Бэкап ещё не выполнен', subtitle: 'Запланирован на 18:00 МСК' }
}

export function backupStatusTooltip(status) {
  const view = backupStatusPresentation(status)
  const parts = [view.title]
  if (status?.completed_at) parts.push(`Завершён: ${new Date(status.completed_at).toLocaleString('ru-RU')}`)
  if (status?.version) parts.push(`Версия приложения: ${status.version}`)
  if (status?.database_version) parts.push(`PostgreSQL: ${status.database_version}`)
  if (status?.backup_name) parts.push(`Файл: ${status.backup_name}`)
  if (status?.size_bytes) parts.push(`Размер: ${formatBytes(status.size_bytes)}`)
  if (status?.next_run) parts.push(`Следующий запуск: ${new Date(status.next_run).toLocaleString('ru-RU')}`)
  return parts.join('\n')
}

function formatBytes(value) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} КБ`
  return `${(value / 1024 / 1024).toFixed(1)} МБ`
}
