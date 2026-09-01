const pdfPrintDelay = 450
const fallbackPrintDelay = 1400
const imageFallbackPrintDelay = 5000
const cleanupDelay = 120000

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

export function imagePrintDocument(url, title) {
  const safeURL = escapeHTML(url)
  const safeTitle = escapeHTML(title)
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    @page{size:auto;margin:8mm}
    html,body{width:100%;min-height:100%;margin:0;padding:0;background:#fff}
    body{display:flex;align-items:flex-start;justify-content:center}
    img{display:block;width:auto;height:auto;max-width:100%;max-height:calc(100vh - 1px);object-fit:contain;break-inside:avoid;page-break-inside:avoid}
  </style></head><body><img src="${safeURL}" alt="${safeTitle}"></body></html>`
}

export function printOriginalScan({ url, type = '', title = 'Скан документа', documentObject = document, windowObject = window, onError = () => {} }) {
  if (!url) throw new Error('Исходный файл скана ещё не загружен')

  const frame = documentObject.createElement('iframe')
  frame.className = 'scan-print-frame'
  frame.title = `Печать: ${title}`
  frame.setAttribute('aria-hidden', 'true')

  let started = false
  let cleanupTimer = 0
  const cleanup = () => {
    if (cleanupTimer) windowObject.clearTimeout(cleanupTimer)
    if (frame.parentNode) frame.parentNode.removeChild(frame)
  }
  const print = () => {
    if (started) return
    const target = frame.contentWindow
    if (!target) return
    started = true
    try {
      target.addEventListener?.('afterprint', cleanup, { once: true })
      target.focus?.()
      target.print()
      cleanupTimer = windowObject.setTimeout(cleanup, cleanupDelay)
    } catch (error) {
      cleanup()
      onError(error)
    }
  }

  frame.addEventListener('load', () => {
    windowObject.setTimeout(print, type === 'application/pdf' ? pdfPrintDelay : 0)
  }, { once: true })
  if (type.startsWith('image/')) frame.srcdoc = imagePrintDocument(url, title)
  else frame.src = url
  documentObject.body.appendChild(frame)
  windowObject.setTimeout(print, type === 'application/pdf' ? fallbackPrintDelay : imageFallbackPrintDelay)
  return cleanup
}
