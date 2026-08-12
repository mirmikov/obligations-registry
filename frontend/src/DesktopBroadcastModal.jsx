import { Megaphone, Send, X } from 'lucide-react'
import { useState } from 'react'
import { request } from './api'
import { buildDesktopBroadcastPayload, desktopBroadcastDestinations } from './desktopBroadcast'

export default function DesktopBroadcastModal({ onClose, onSent }) {
  const [form, setForm] = useState({ title: 'Обновление ФинРеестра', body: '', action_url: '/?page=registry' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async event => {
    event.preventDefault()
    const payload = buildDesktopBroadcastPayload(form)
    if (!payload.title || !payload.body) { setError('Заполните заголовок и текст уведомления'); return }
    setSaving(true); setError('')
    try {
      const result = await request('/api/desktop/notifications', { method: 'POST', body: JSON.stringify(payload) })
      onSent(result.created)
    } catch (requestError) {
      setError(requestError.message)
      setSaving(false)
    }
  }
  return <div className="modal-backdrop desktop-broadcast-backdrop" onMouseDown={event => event.target === event.currentTarget && !saving && onClose()}>
    <form className="modal desktop-broadcast-modal" role="dialog" aria-modal="true" aria-labelledby="desktop-broadcast-title" onSubmit={submit}>
      <header className="modal-head"><div><p className="eyebrow">Windows-приложение</p><h2 id="desktop-broadcast-title"><Megaphone size={22}/>Уведомление сотрудникам</h2><span>Сообщение появится на компьютерах с установленным приложением ФинРеестра.</span></div><button type="button" onClick={onClose} disabled={saving} aria-label="Закрыть"><X/></button></header>
      <div className="modal-body desktop-broadcast-body">
        <label className="field"><span>Заголовок</span><input value={form.title} maxLength="160" onChange={event => setForm(current => ({ ...current, title: event.target.value }))} autoFocus required/><small>{form.title.length}/160</small></label>
        <label className="field desktop-broadcast-message"><span>Текст уведомления</span><textarea value={form.body} maxLength="1000" rows="6" placeholder="Например: Внесены обновления. Обновите страницу ФинРеестра." onChange={event => setForm(current => ({ ...current, body: event.target.value }))} required/><small>{form.body.length}/1000</small></label>
        <label className="field"><span>Куда перейти при нажатии</span><select value={form.action_url} onChange={event => setForm(current => ({ ...current, action_url: event.target.value }))}>{desktopBroadcastDestinations.map(item => <option key={item.value || 'none'} value={item.value}>{item.label}</option>)}</select></label>
        <div className="desktop-broadcast-audience"><strong>Получатели: все активные пользователи</strong><span>Отправка не зависит от того, открыта ли сейчас страница ФинРеестра.</span></div>
        {error && <div className="form-error">{error}</div>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary" onClick={onClose} disabled={saving}>Отмена</button><button type="submit" className="primary" disabled={saving}><Send size={16}/>{saving ? 'Отправляем…' : 'Отправить на ПК'}</button></footer>
    </form>
  </div>
}
