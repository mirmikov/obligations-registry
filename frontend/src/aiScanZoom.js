export const AI_SCAN_ZOOM_MIN = 50
export const AI_SCAN_ZOOM_MAX = 300
export const AI_SCAN_ZOOM_STEP = 25

export function clampAIScanZoom(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 100
  return Math.min(AI_SCAN_ZOOM_MAX, Math.max(AI_SCAN_ZOOM_MIN, numeric))
}

export function nextAIScanZoom(current, direction) {
  return clampAIScanZoom(Number(current) + (direction < 0 ? -AI_SCAN_ZOOM_STEP : AI_SCAN_ZOOM_STEP))
}
