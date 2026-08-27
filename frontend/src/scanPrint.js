const pdfPrintDelay = 450
const fallbackPrintDelay = 1400
const cleanupDelay = 120000

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
  frame.src = url
  documentObject.body.appendChild(frame)
  windowObject.setTimeout(print, type === 'application/pdf' ? fallbackPrintDelay : 300)
  return cleanup
}
