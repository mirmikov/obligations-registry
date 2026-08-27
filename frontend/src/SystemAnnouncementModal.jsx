import { Info, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { request } from './api'

export default function SystemAnnouncementModal({ announcement, onClose, onSaved, notify }) {
  const [message, setMessage] = useState(announcement?.message || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const close = event => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, saving])

  const save = async active => {
    const prepared = message.trim()
    if (active && !prepared) { notify('Введите текст системного сообщения', 'error'); return }
    setSaving(true)
    try {
      const result = await request('/api/system/announcement', {
        method: 'PUT',
        body: JSON.stringify({ active, message: prepared }),
      })
      onSaved(result.announcement)
      notify(active ? 'Системное сообщение показано всем' : 'Системное сообщение выключено')
    } catch (error) {
      notify(error.message, 'error')
      setSaving(false)
    }
  }

  return <div className="modal-backdrop system-announcement-backdrop" onMouseDown={event => event.target === event.currentTarget && !saving && onClose()}>
    <section className="modal system-announcement-modal" role="dialog" aria-modal="true" aria-labelledby="system-announcement-title">
      <header className="modal-head"><div><p className="eyebrow">Системная панель</p><h2 id="system-announcement-title"><Info size={22}/>Сообщение всем пользователям</h2><span>Синий баннер появится сверху у всех пользователей и не помешает работе.</span></div><button type="button" onClick={onClose} disabled={saving} aria-label="Закрыть"><X/></button></header>
      <div className="modal-body system-announcement-body">
        <label className="field"><span>Текст сообщения</span><textarea value={message} maxLength="500" rows="5" autoFocus placeholder="Например: Обновите страницу — доступна новая версия программы." onChange={event => setMessage(event.target.value)}/><small>{message.length}/500</small></label>
        <div className="system-announcement-preview"><Info size={16}/><span>{message.trim() || 'Здесь будет показан текст системного сообщения'}</span></div>
      </div>
      <footer className="modal-footer"><button type="button" className="secondary" onClick={onClose} disabled={saving}>Отмена</button>{announcement?.active && <button type="button" className="secondary system-announcement-disable" onClick={() => save(false)} disabled={saving}>Выключить баннер</button>}<button type="button" className="primary system-announcement-save" onClick={() => save(true)} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16}/> : <Info size={16}/>} {announcement?.active ? 'Обновить сообщение' : 'Показать всем'}</button></footer>
    </section>
  </div>
}
