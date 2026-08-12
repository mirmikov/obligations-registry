export const desktopBroadcastDestinations = [
  { value: '/?page=registry', label: 'Реестр обязательств' },
  { value: '/?page=dashboard', label: 'Общая сводка' },
  { value: '/?page=chat', label: 'Сообщения' },
  { value: '', label: 'Без перехода' },
]

export function buildDesktopBroadcastPayload(values) {
  return {
    kind: 'system.broadcast',
    title: String(values.title || '').trim(),
    body: String(values.body || '').trim(),
    action_url: desktopBroadcastDestinations.some(item => item.value === values.action_url) ? values.action_url : '',
    user_ids: [],
  }
}
