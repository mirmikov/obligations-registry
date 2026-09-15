export function formatDiskBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const gibibytes = bytes / (1024 ** 3)
  return `${gibibytes.toLocaleString('ru-RU', { maximumFractionDigits: gibibytes >= 100 ? 0 : 1 })} ГБ`
}

export function diskStatusPresentation(status) {
  if (status?.state !== 'available') {
    return { title: 'Диск VM', subtitle: 'Нет данных', tone: 'error' }
  }
  const usedPercent = Math.max(0, Math.min(100, Number(status.used_percent) || 0))
  return {
    title: `Диск VM · ${usedPercent.toLocaleString('ru-RU')}%`,
    subtitle: `${formatDiskBytes(status.used_bytes)} из ${formatDiskBytes(status.total_bytes)}`,
    tone: usedPercent >= 90 ? 'error' : usedPercent >= 80 ? 'warning' : 'success',
  }
}

export function diskStatusTooltip(status) {
  const view = diskStatusPresentation(status)
  if (status?.state !== 'available') return `${view.title}. ${view.subtitle}`
  return `${view.title}. Занято ${formatDiskBytes(status.used_bytes)} из ${formatDiskBytes(status.total_bytes)}. Свободно ${formatDiskBytes(status.available_bytes)}.`
}
