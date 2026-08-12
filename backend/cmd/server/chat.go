package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
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
	Category    string     `json:"category,omitempty"`
	Subject     string     `json:"subject,omitempty"`
	CreatedBy   int64      `json:"created_by"`
	DirectKey   string     `json:"-"`
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
	ImageURL       string `json:"image_url,omitempty"`
	AttachmentURL  string `json:"attachment_url,omitempty"`
	AttachmentName string `json:"attachment_name,omitempty"`
	AttachmentType string `json:"attachment_type,omitempty"`
	AttachmentSize int64  `json:"attachment_size,omitempty"`
	AIScannable    bool   `json:"ai_scannable,omitempty"`
	CreatedAt      string `json:"created_at"`
}

type chatAttachment struct {
	StoredName   string `json:"stored_name"`
	OriginalName string `json:"original_name"`
	ContentType  string `json:"content_type"`
	Size         int64  `json:"size"`
}

const (
	chatImageMarker  = "[[chat-image:"
	chatFileMarker   = "[[chat-file:"
	maxChatImageSize = 8 << 20
	maxChatFileSize  = 25 << 20
)

func (a *app) listChatUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT u.id,u.name,u.email,u.role,COALESCE(s.state,'{}'::jsonb)
		FROM users u LEFT JOIN user_workspace_state s ON s.user_id=u.id
		WHERE u.active ORDER BY u.name,u.email`)
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
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.Role, &raw); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка списка пользователей")
			return
		}
		if isDeveloperEmail(item.Email) {
			item.Role = "developer"
		} else {
			item.Role = profileRoleFromState(raw, item.Role)
		}
		item.Online = online[item.ID]
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) listChatConversations(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT c.id,c.kind,COALESCE(c.name,''),c.created_by,COALESCE(c.direct_key,''),
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
			AND (COALESCE(c.direct_key,'') NOT LIKE $2 OR c.created_by=$1 OR $3)
		ORDER BY COALESCE(last_message.created_at,c.updated_at) DESC,c.id DESC`, user.ID, accountingConversationKeyPrefix+"%", user.Permissions["invoice_mail.inbox"])
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить диалоги")
		return
	}
	defer rows.Close()
	items := []chatConversation{}
	for rows.Next() {
		var item chatConversation
		if err := rows.Scan(&item.ID, &item.Kind, &item.Name, &item.CreatedBy, &item.DirectKey, &item.Title, &item.LastMessage, &item.LastSender, &item.LastAt, &item.Unread); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка списка диалогов")
			return
		}
		item.Members, err = a.chatMembers(r, item.ID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось загрузить участников")
			return
		}
		if isAccountingConversationKey(item.DirectKey) {
			item.Category = accountingConversationCategory
			item.Subject = item.Name
			item.Title = item.Name
		}
		if body, attachment := decodeChatAttachmentBody(item.LastMessage); attachment != nil {
			item.LastMessage = strings.TrimSpace("Файл: " + attachment.OriginalName + " " + body)
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) chatMembers(r *http.Request, conversationID int64) ([]chatUser, error) {
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT u.id,u.name,u.email,u.role,COALESCE(s.state,'{}'::jsonb)
		FROM chat_members cm
		JOIN users u ON u.id=cm.user_id
		LEFT JOIN user_workspace_state s ON s.user_id=u.id
		WHERE cm.conversation_id=$1 ORDER BY u.name,u.id`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []chatUser{}
	for rows.Next() {
		var item chatUser
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Name, &item.Email, &item.Role, &raw); err != nil {
			return nil, err
		}
		if isDeveloperEmail(item.Email) {
			item.Role = "developer"
		} else {
			item.Role = profileRoleFromState(raw, item.Role)
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
		applyChatMessagePresentation(&item, conversationID)
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
	body, attachment, ok := a.readChatMessageInput(w, r, conversationID)
	if !ok {
		return
	}
	storedBody := encodeChatAttachmentBody(body, attachment)
	if storedBody == "" || utf8.RuneCountInString(storedBody) > 4000 {
		if attachment != nil {
			_ = os.Remove(filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), attachment.StoredName))
		}
		fail(w, http.StatusBadRequest, "Сообщение вместе с данными файла должно содержать не больше 4000 символов")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		if attachment != nil {
			_ = os.Remove(filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), attachment.StoredName))
		}
		fail(w, http.StatusInternalServerError, "Не удалось начать отправку сообщения")
		return
	}
	defer tx.Rollback()
	var item chatMessage
	err = tx.QueryRowContext(r.Context(), `
		WITH inserted AS (
			INSERT INTO chat_messages(conversation_id,sender_id,body) VALUES($1,$2,$3)
			RETURNING id,conversation_id,sender_id,body,created_at
		)
			SELECT i.id,i.conversation_id,i.sender_id,$4,i.body,to_char(i.created_at,'YYYY-MM-DD HH24:MI:SS') FROM inserted i`, conversationID, user.ID, storedBody, user.Name).Scan(
		&item.ID, &item.ConversationID, &item.SenderID, &item.SenderName, &item.Body, &item.CreatedAt,
	)
	if err != nil {
		if attachment != nil {
			_ = os.Remove(filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), attachment.StoredName))
		}
		fail(w, http.StatusInternalServerError, "Не удалось отправить сообщение")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE chat_conversations SET updated_at=now() WHERE id=$1`, conversationID); err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE chat_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, conversationID, user.ID)
	}
	if err == nil {
		err = enqueueChatDesktopNotifications(r.Context(), tx, conversationID, item.ID, user.ID, user.Name, storedBody)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		if attachment != nil {
			_ = os.Remove(filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), attachment.StoredName))
		}
		fail(w, http.StatusInternalServerError, "Не удалось завершить отправку сообщения")
		return
	}
	applyChatMessagePresentation(&item, conversationID)
	writeJSON(w, http.StatusCreated, item)
}

func (a *app) readChatMessageInput(w http.ResponseWriter, r *http.Request, conversationID int64) (string, *chatAttachment, bool) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		var input struct {
			Body string `json:"body"`
		}
		if !decodeJSON(w, r, &input) {
			return "", nil, false
		}
		body := strings.TrimSpace(input.Body)
		if body == "" || utf8.RuneCountInString(body) > 4000 {
			fail(w, http.StatusBadRequest, "Сообщение должно содержать от 1 до 4000 символов")
			return "", nil, false
		}
		return body, nil, true
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxChatFileSize+(256<<10))
	if err := r.ParseMultipartForm(maxChatFileSize + (128 << 10)); err != nil {
		fail(w, http.StatusBadRequest, "Не удалось прочитать файл")
		return "", nil, false
	}
	defer r.MultipartForm.RemoveAll()
	body := strings.TrimSpace(r.FormValue("body"))
	if utf8.RuneCountInString(body) > 3900 {
		fail(w, http.StatusBadRequest, "Подпись к файлу слишком длинная")
		return "", nil, false
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		file, header, err = r.FormFile("image") // backwards compatibility for pasted images
	}
	if err != nil {
		fail(w, http.StatusBadRequest, "Выберите файл")
		return "", nil, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxChatFileSize+1))
	if err != nil || len(data) == 0 || len(data) > maxChatFileSize {
		fail(w, http.StatusBadRequest, "Файл должен быть не больше 25 МБ")
		return "", nil, false
	}
	extension, contentType, ok := chatFileType(header.Filename, data)
	if !ok {
		fail(w, http.StatusBadRequest, "Поддерживаются PDF, изображения, DOCX, XLSX, CSV, TXT и ZIP")
		return "", nil, false
	}
	name, err := saveChatFile(conversationID, extension, data)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить файл")
		return "", nil, false
	}
	originalName := safeChatOriginalName(header.Filename, extension)
	return body, &chatAttachment{StoredName: name, OriginalName: originalName, ContentType: contentType, Size: int64(len(data))}, true
}

func (a *app) serveChatImage(w http.ResponseWriter, r *http.Request) {
	a.serveChatStoredFile(w, r, true)
}

func (a *app) serveChatAttachment(w http.ResponseWriter, r *http.Request) {
	a.serveChatStoredFile(w, r, false)
}

func (a *app) serveChatStoredFile(w http.ResponseWriter, r *http.Request, legacyImage bool) {
	conversationID, ok := a.chatConversationAccess(w, r)
	if !ok {
		return
	}
	name := r.PathValue("name")
	if !validChatStorageName(name) {
		fail(w, http.StatusBadRequest, "Некорректный файл")
		return
	}
	attachment, exists := a.findChatAttachment(r, conversationID, name)
	if !exists || (legacyImage && !strings.HasPrefix(attachment.ContentType, "image/")) {
		fail(w, http.StatusNotFound, "Файл не найден")
		return
	}
	path := filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), name)
	file, err := os.Open(path)
	if err != nil {
		fail(w, http.StatusNotFound, "Файл не найден")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusNotFound, "Файл не найден")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", attachment.ContentType)
	disposition := "attachment"
	if strings.HasPrefix(attachment.ContentType, "image/") || attachment.ContentType == "application/pdf" {
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": attachment.OriginalName}))
	http.ServeContent(w, r, attachment.OriginalName, info.ModTime(), file)
}

func (a *app) findChatAttachment(r *http.Request, conversationID int64, name string) (*chatAttachment, bool) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT body FROM chat_messages WHERE conversation_id=$1 AND (body LIKE $2 OR body LIKE $3)`, conversationID, chatFileMarker+"%", chatImageMarker+name+"]]%")
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	for rows.Next() {
		var stored string
		if rows.Scan(&stored) != nil {
			return nil, false
		}
		_, attachment := decodeChatAttachmentBody(stored)
		if attachment != nil && attachment.StoredName == name {
			return attachment, true
		}
	}
	return nil, false
}

func chatImageDirectory() string { return getenv("CHAT_UPLOAD_DIR", "/data/chat_uploads") }

func chatImageExtension(data []byte) (string, bool) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return ".png", true
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		return ".jpg", true
	case bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")):
		return ".gif", true
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp", true
	default:
		return "", false
	}
}

func chatFileType(originalName string, data []byte) (string, string, bool) {
	if extension, ok := chatImageExtension(data); ok {
		return extension, chatImageContentType(extension), true
	}
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		return ".pdf", "application/pdf", true
	}
	extension := strings.ToLower(filepath.Ext(originalName))
	if bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		switch extension {
		case ".docx":
			return extension, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", true
		case ".xlsx":
			return extension, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true
		case ".zip":
			return extension, "application/zip", true
		}
	}
	if bytes.IndexByte(data, 0) < 0 {
		switch extension {
		case ".txt":
			return extension, "text/plain; charset=utf-8", true
		case ".csv":
			return extension, "text/csv; charset=utf-8", true
		}
	}
	return "", "", false
}

func saveChatImage(conversationID int64, extension string, data []byte) (string, error) {
	return saveChatFile(conversationID, extension, data)
}

func saveChatFile(conversationID int64, extension string, data []byte) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	name := hex.EncodeToString(random) + extension
	directory := filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10))
	if err := os.MkdirAll(directory, 0750); err != nil {
		return "", err
	}
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0640)
	if err != nil {
		return "", err
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return name, nil
}

func safeChatOriginalName(name, extension string) string {
	name = strings.TrimSpace(filepath.Base(strings.ReplaceAll(name, "\\", "/")))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." {
		name = "document" + extension
	}
	runes := []rune(name)
	if len(runes) > 180 {
		name = string(runes[:180])
	}
	return name
}

func encodeChatAttachmentBody(body string, attachment *chatAttachment) string {
	body = strings.TrimSpace(body)
	if attachment == nil {
		return body
	}
	encoded, err := json.Marshal(attachment)
	if err != nil {
		return ""
	}
	marker := chatFileMarker + base64.RawURLEncoding.EncodeToString(encoded) + "]]"
	if body == "" {
		return marker
	}
	return marker + "\n" + body
}

func decodeChatAttachmentBody(stored string) (string, *chatAttachment) {
	if strings.HasPrefix(stored, chatFileMarker) {
		end := strings.Index(stored, "]]")
		if end >= len(chatFileMarker) {
			payload, err := base64.RawURLEncoding.DecodeString(stored[len(chatFileMarker):end])
			var attachment chatAttachment
			if err == nil && json.Unmarshal(payload, &attachment) == nil && validChatStorageName(attachment.StoredName) && attachment.OriginalName != "" && attachment.ContentType != "" && attachment.Size > 0 {
				return strings.TrimSpace(stored[end+2:]), &attachment
			}
		}
		return stored, nil
	}
	body, imageName := decodeChatMessageBody(stored)
	if imageName == "" {
		return body, nil
	}
	return body, &chatAttachment{StoredName: imageName, OriginalName: "image" + filepath.Ext(imageName), ContentType: chatImageContentType(filepath.Ext(imageName)), Size: 1}
}

func applyChatMessagePresentation(item *chatMessage, conversationID int64) {
	body, attachment := decodeChatAttachmentBody(item.Body)
	item.Body = body
	if attachment == nil {
		return
	}
	item.AttachmentURL = fmt.Sprintf("/api/chat/conversations/%d/files/%s", conversationID, attachment.StoredName)
	item.AttachmentName = attachment.OriginalName
	item.AttachmentType = attachment.ContentType
	item.AttachmentSize = attachment.Size
	item.AIScannable = attachment.ContentType == "application/pdf" || attachment.ContentType == "image/png" || attachment.ContentType == "image/jpeg"
	if strings.HasPrefix(attachment.ContentType, "image/") {
		item.ImageURL = item.AttachmentURL
	}
}

func encodeChatMessageBody(body, imageName string) string {
	body = strings.TrimSpace(body)
	if imageName == "" {
		return body
	}
	if body == "" {
		return chatImageMarker + imageName + "]]"
	}
	return chatImageMarker + imageName + "]]\n" + body
}

func decodeChatMessageBody(stored string) (string, string) {
	if !strings.HasPrefix(stored, chatImageMarker) {
		return stored, ""
	}
	end := strings.Index(stored, "]]")
	if end < len(chatImageMarker) {
		return stored, ""
	}
	name := stored[len(chatImageMarker):end]
	if !validChatImageName(name) {
		return stored, ""
	}
	return strings.TrimSpace(stored[end+2:]), name
}

func chatMessagePresentation(stored string, conversationID int64) (string, string) {
	body, attachment := decodeChatAttachmentBody(stored)
	if attachment == nil {
		return body, ""
	}
	return body, fmt.Sprintf("/api/chat/conversations/%d/files/%s", conversationID, attachment.StoredName)
}

func validChatImageName(name string) bool {
	if len(name) < 36 || filepath.Base(name) != name {
		return false
	}
	base, extension := strings.TrimSuffix(name, filepath.Ext(name)), strings.ToLower(filepath.Ext(name))
	if len(base) != 32 || (extension != ".png" && extension != ".jpg" && extension != ".gif" && extension != ".webp") {
		return false
	}
	_, err := hex.DecodeString(base)
	return err == nil
}

func validChatStorageName(name string) bool {
	if len(name) < 36 || filepath.Base(name) != name {
		return false
	}
	base, extension := strings.TrimSuffix(name, filepath.Ext(name)), strings.ToLower(filepath.Ext(name))
	allowed := map[string]bool{".png": true, ".jpg": true, ".gif": true, ".webp": true, ".pdf": true, ".docx": true, ".xlsx": true, ".zip": true, ".txt": true, ".csv": true}
	if len(base) != 32 || !allowed[extension] {
		return false
	}
	_, err := hex.DecodeString(base)
	return err == nil
}

func chatImageContentType(extension string) string {
	return map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[strings.ToLower(extension)]
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
	user := currentUser(r)
	var exists bool
	err = a.db.QueryRowContext(r.Context(), `
		SELECT EXISTS(
			SELECT 1
			FROM chat_members cm
			JOIN chat_conversations c ON c.id=cm.conversation_id
			WHERE cm.conversation_id=$1 AND cm.user_id=$2
				AND (COALESCE(c.direct_key,'') NOT LIKE $3 OR c.created_by=$2 OR $4)
		)`, id, user.ID, accountingConversationKeyPrefix+"%", user.Permissions["invoice_mail.inbox"]).Scan(&exists)
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
