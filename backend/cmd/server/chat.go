package main

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type chatUser struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	Online bool   `json:"online"`
}

type chatConversation struct {
	ID          int64      `json:"id"`
	Kind        string     `json:"kind"`
	Name        string     `json:"name"`
	Title       string     `json:"title"`
	Members     []chatUser `json:"members"`
	LastMessage string     `json:"last_message"`
	LastSender  string     `json:"last_sender"`
	LastAt      string     `json:"last_at"`
	Unread      int        `json:"unread"`
}

type chatMessage struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	SenderID       int64  `json:"sender_id"`
	SenderName     string `json:"sender_name"`
	Body           string `json:"body"`
	CreatedAt      string `json:"created_at"`
}

func (a *app) listChatUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,email,role FROM users WHERE active ORDER BY name,email`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить пользователей чата")
		return
	}
	defer rows.Close()
	online := map[int64]bool{}
	for _, item := range a.presence.list(time.Now()) {
		online[item.UserID] = true
	}
	items := []chatUser{}
	for rows.Next() {
		var item chatUser
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.Role); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка списка пользователей")
			return
		}
		item.Online = online[item.ID]
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) listChatConversations(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT c.id,c.kind,COALESCE(c.name,''),
			CASE WHEN c.kind='direct' THEN COALESCE((SELECT u.name FROM chat_members other JOIN users u ON u.id=other.user_id WHERE other.conversation_id=c.id AND other.user_id<>$1 LIMIT 1),'Личный чат') ELSE COALESCE(c.name,'Группа') END,
			COALESCE(last_message.body,''),COALESCE(last_message.sender_name,''),COALESCE(to_char(last_message.created_at,'YYYY-MM-DD HH24:MI:SS'),''),
			(SELECT count(*) FROM chat_messages unread WHERE unread.conversation_id=c.id AND unread.sender_id<>$1 AND unread.created_at>mine.last_read_at)
		FROM chat_members mine
		JOIN chat_conversations c ON c.id=mine.conversation_id
		LEFT JOIN LATERAL (
			SELECT m.body,u.name AS sender_name,m.created_at FROM chat_messages m JOIN users u ON u.id=m.sender_id
			WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1
		) last_message ON true
		WHERE mine.user_id=$1
		ORDER BY COALESCE(last_message.created_at,c.updated_at) DESC,c.id DESC`, user.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить диалоги")
		return
	}
	defer rows.Close()
	items := []chatConversation{}
	for rows.Next() {
		var item chatConversation
		if err := rows.Scan(&item.ID, &item.Kind, &item.Name, &item.Title, &item.LastMessage, &item.LastSender, &item.LastAt, &item.Unread); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка списка диалогов")
			return
		}
		item.Members, err = a.chatMembers(r, item.ID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось загрузить участников")
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) chatMembers(r *http.Request, conversationID int64) ([]chatUser, error) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT u.id,u.name,u.email,u.role FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 ORDER BY u.name,u.id`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []chatUser{}
	for rows.Next() {
		var item chatUser
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.Role); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (a *app) createDirectChat(w http.ResponseWriter, r *http.Request) {
	var input struct {
		UserID int64 `json:"user_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user := currentUser(r)
	if input.UserID <= 0 || input.UserID == user.ID {
		fail(w, http.StatusBadRequest, "Выберите другого пользователя")
		return
	}
	var active bool
	if err := a.db.QueryRowContext(r.Context(), `SELECT active FROM users WHERE id=$1`, input.UserID).Scan(&active); err != nil || !active {
		fail(w, http.StatusBadRequest, "Пользователь недоступен")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать диалог")
		return
	}
	defer tx.Rollback()
	key := directChatKey(user.ID, input.UserID)
	var id int64
	err = tx.QueryRowContext(r.Context(), `INSERT INTO chat_conversations(kind,direct_key,created_by) VALUES('direct',$1,$2) ON CONFLICT(direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id`, key, user.ID).Scan(&id)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO chat_members(conversation_id,user_id) VALUES($1,$2),($1,$3) ON CONFLICT DO NOTHING`, id, user.ID, input.UserID)
	}
	if err != nil || tx.Commit() != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать диалог")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (a *app) createGroupChat(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name      string  `json:"name"`
		MemberIDs []int64 `json:"member_ids"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 80 {
		fail(w, http.StatusBadRequest, "Укажите название группы до 80 символов")
		return
	}
	user := currentUser(r)
	members := uniqueChatMembers(input.MemberIDs, user.ID)
	if len(members) < 2 {
		fail(w, http.StatusBadRequest, "Добавьте хотя бы одного участника")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать группу")
		return
	}
	defer tx.Rollback()
	var id int64
	if err = tx.QueryRowContext(r.Context(), `INSERT INTO chat_conversations(kind,name,created_by) VALUES('group',$1,$2) RETURNING id`, input.Name, user.ID).Scan(&id); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать группу")
		return
	}
	added := 0
	for _, memberID := range members {
		result, insertErr := tx.ExecContext(r.Context(), `INSERT INTO chat_members(conversation_id,user_id) SELECT $1,id FROM users WHERE id=$2 AND active ON CONFLICT DO NOTHING`, id, memberID)
		if insertErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось добавить участников")
			return
		}
		count, _ := result.RowsAffected()
		added += int(count)
	}
	if added < 2 {
		fail(w, http.StatusBadRequest, "Не выбраны доступные участники")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить группу")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (a *app) listChatMessages(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := a.chatConversationAccess(w, r)
	if !ok {
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT id,conversation_id,sender_id,sender_name,body,created_at FROM (
			SELECT m.id,m.conversation_id,m.sender_id,u.name AS sender_name,m.body,to_char(m.created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
			FROM chat_messages m JOIN users u ON u.id=m.sender_id
			WHERE m.conversation_id=$1 AND m.id>$2 ORDER BY m.id DESC LIMIT 300
		) recent ORDER BY id`, conversationID, after)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить сообщения")
		return
	}
	defer rows.Close()
	items := []chatMessage{}
	for rows.Next() {
		var item chatMessage
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.SenderID, &item.SenderName, &item.Body, &item.CreatedAt); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка истории сообщений")
			return
		}
		items = append(items, item)
	}
	_, _ = a.db.ExecContext(r.Context(), `UPDATE chat_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, conversationID, currentUser(r).ID)
	writeJSON(w, http.StatusOK, items)
}

func (a *app) sendChatMessage(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := a.chatConversationAccess(w, r)
	if !ok {
		return
	}
	var input struct {
		Body string `json:"body"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Body = strings.TrimSpace(input.Body)
	if input.Body == "" || utf8.RuneCountInString(input.Body) > 4000 {
		fail(w, http.StatusBadRequest, "Сообщение должно содержать от 1 до 4000 символов")
		return
	}
	user := currentUser(r)
	var item chatMessage
	err := a.db.QueryRowContext(r.Context(), `
		WITH inserted AS (
			INSERT INTO chat_messages(conversation_id,sender_id,body) VALUES($1,$2,$3)
			RETURNING id,conversation_id,sender_id,body,created_at
		)
		SELECT i.id,i.conversation_id,i.sender_id,$4,i.body,to_char(i.created_at,'YYYY-MM-DD HH24:MI:SS') FROM inserted i`, conversationID, user.ID, input.Body, user.Name).Scan(
		&item.ID, &item.ConversationID, &item.SenderID, &item.SenderName, &item.Body, &item.CreatedAt,
	)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось отправить сообщение")
		return
	}
	_, _ = a.db.ExecContext(r.Context(), `UPDATE chat_conversations SET updated_at=now() WHERE id=$1`, conversationID)
	_, _ = a.db.ExecContext(r.Context(), `UPDATE chat_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, conversationID, user.ID)
	writeJSON(w, http.StatusCreated, item)
}

func (a *app) markChatRead(w http.ResponseWriter, r *http.Request) {
	conversationID, ok := a.chatConversationAccess(w, r)
	if !ok {
		return
	}
	_, err := a.db.ExecContext(r.Context(), `UPDATE chat_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, conversationID, currentUser(r).ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось отметить сообщения прочитанными")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) chatConversationAccess(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, http.StatusBadRequest, "Некорректный диалог")
		return 0, false
	}
	var exists bool
	err = a.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM chat_members WHERE conversation_id=$1 AND user_id=$2)`, id, currentUser(r).ID).Scan(&exists)
	if err != nil || !exists {
		fail(w, http.StatusForbidden, "Диалог недоступен")
		return 0, false
	}
	return id, true
}

func directChatKey(first, second int64) string {
	if first > second {
		first, second = second, first
	}
	return fmt.Sprintf("%d:%d", first, second)
}

func uniqueChatMembers(values []int64, current int64) []int64 {
	seen := map[int64]bool{current: true}
	result := []int64{current}
	for _, value := range values {
		if value > 0 && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}
