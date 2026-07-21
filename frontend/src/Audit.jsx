import { useEffect, useState } from 'react'
import { FileClock } from 'lucide-react'
import { request } from './api'
import { dateTime, PageHeader } from './App'

const actions={create:'Создание',update:'Изменение',delete:'Удаление',bulk_update:'Массовое изменение',import:'Импорт',split:'Разбиение платежа',undo:'Отмена действия'}
const entities={obligation:'обязательство',reference:'справочник',user:'пользователя',operation:'операцию'}
export default function Audit({notify}){const [items,setItems]=useState([]);useEffect(()=>{request('/api/audit').then(setItems).catch(e=>notify(e.message,'error'))},[]);return <div className="page"><PageHeader eyebrow="Контроль изменений" title="Журнал действий" subtitle="Последние 500 операций пользователей"/><section className="panel audit-panel">{items.length===0?<div className="empty-state"><FileClock/><strong>Действий пока нет</strong></div>:items.map(item=><div className="audit-row" key={item.id}><div className={`audit-icon action-${item.action}`}><FileClock size={17}/></div><div><strong>{item.user}</strong><span>{actions[item.action]||item.action} · {entities[item.entity_type]||item.entity_type}{item.entity_id?` №${item.entity_id}`:''}</span></div><time>{dateTime(item.created_at)}</time></div>)}</section></div>}
