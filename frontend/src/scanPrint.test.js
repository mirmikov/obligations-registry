import assert from 'node:assert/strict'
import test from 'node:test'
import { imagePrintDocument, printOriginalScan } from './scanPrint.js'

function printEnvironment() {
  const scheduled = []
  const listeners = new Map()
  const calls = { focused: 0, printed: 0, removed: 0 }
  const frame = {
    parentNode: null,
    contentWindow: {
      addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
      focus: () => { calls.focused += 1 },
      print: () => { calls.printed += 1 },
    },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setAttribute: () => {},
  }
  const body = {
    appendChild: node => { node.parentNode = body },
    removeChild: node => { node.parentNode = null; calls.removed += 1 },
  }
  return {
    calls,
    frame,
    listeners,
    scheduled,
    documentObject: { body, createElement: tag => { assert.equal(tag, 'iframe'); return frame } },
    windowObject: {
      setTimeout: (handler, delay) => { scheduled.push({ handler, delay }); return scheduled.length },
      clearTimeout: () => {},
    },
  }
}

test('printing passes the original blob URL directly to an iframe', () => {
  const environment = printEnvironment()
  const url = 'blob:http://registry.local/original-pdf-bytes'
  printOriginalScan({ url, type: 'application/pdf', title: 'Счёт № 17.pdf', ...environment })

  assert.equal(environment.frame.src, url)
  assert.equal(environment.frame.className, 'scan-print-frame')
  assert.equal(environment.scheduled[0].delay, 1400)
  environment.listeners.get('load')()
  assert.equal(environment.scheduled[1].delay, 450)
  environment.scheduled[1].handler()
  assert.equal(environment.calls.focused, 1)
  assert.equal(environment.calls.printed, 1)
})

test('image printing does not create a canvas or transform the source', () => {
  const environment = printEnvironment()
  let createdTags = []
  environment.documentObject.createElement = tag => { createdTags.push(tag); return environment.frame }
  printOriginalScan({ url: 'blob:http://registry.local/original-image-bytes', type: 'image/png', ...environment })
  assert.match(environment.frame.srcdoc, /blob:http:\/\/registry\.local\/original-image-bytes/)
  assert.match(environment.frame.srcdoc, /max-width:100%/)
  assert.equal(environment.frame.src, undefined)
  environment.listeners.get('load')()
  environment.scheduled.find(item => item.delay === 0).handler()

  assert.deepEqual(createdTags, ['iframe'])
  assert.equal(environment.calls.printed, 1)
})

test('image print document escapes document data and keeps the original blob URL', () => {
  const html = imagePrintDocument('blob:http://registry.local/image?name="scan"&page=1', 'Счёт <17>')
  assert.match(html, /name=&quot;scan&quot;&amp;page=1/)
  assert.match(html, /Счёт &lt;17&gt;/)
  assert.doesNotMatch(html, /canvas|data:image/)
})

test('temporary print frame is removed after printing', () => {
  const environment = printEnvironment()
  const cleanup = printOriginalScan({ url: 'blob:http://registry.local/scan', type: 'image/jpeg', ...environment })
  cleanup()
  assert.equal(environment.calls.removed, 1)
})
