package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
)

const (
	desktopTokenLifetime       = 30 * 24 * time.Hour
	maxDesktopNotificationWait = 25
)

var desktopNotificationKindPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,49}$`)

type desktopNotification struct {
	ID        int64     `json:"id"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	ActionURL string    `json:"action_url,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type desktopNotificationResponse struct {
	Items      []desktopNotification `json:"items"`
	NextCursor int64                 `json:"next_cursor"`
	ServerTime time.Time             `json:"server_time"`
}

type customDesktopNotificationInput struct {
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	ActionURL string  `json:"action_url"`
	UserIDs   []int64 `json:"user_ids"`
}

func (a *app) desktopLogin(w http.ResponseWriter, r *http.Request) {
	var input loginInput
	if !decodeJSON(w, r, &input) {
		return
	}
	user, err := a.authenticateCredentials(r.Context(), input)
	if err == errInvalidCredentials {
		fail(w, http.StatusUnauthorized, "Неверная почта или пароль")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"sub": strconv.FormatInt(user.ID, 10), "name": user.Name, "email": user.Email,
		"role": user.Role, "aud": desktopTokenAudience, "exp": now.Add(desktopTokenLifetime).Unix(), "iat": now.Unix(),
	}
	token, err := a.signToken(claims)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expires_at": now.Add(desktopTokenLifetime), "user": user})
}

func (a *app) listDesktopNotifications(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	afterID, _ := strconv.ParseInt(r.URL.Query().Get("after_id"), 10, 64)
	if afterID < 0 {
		afterID = 0
	}
	waitSeconds, _ := strconv.Atoi(r.URL.Query().Get("wait_seconds"))
	if waitSeconds < 0 {
		waitSeconds = 0
	}
	if waitSeconds > maxDesktopNotificationWait {
		waitSeconds = maxDesktopNotificationWait
	}

	if afterID == 0 && r.URL.Query().Get("bootstrap") == "1" {
		var cursor int64
		if err := a.db.QueryRowContext(r.Context(), `SELECT COALESCE(max(id),0) FROM desktop_notifications WHERE user_id=$1`, user.ID).Scan(&cursor); err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось открыть канал уведомлений")
			return
		}
		writeJSON(w, http.StatusOK, desktopNotificationResponse{Items: []desktopNotification{}, NextCursor: cursor, ServerTime: time.Now()})
		return
	}

	deadline := time.Now().Add(time.Duration(waitSeconds) * time.Second)
	for {
		items, cursor, err := a.desktopNotificationsAfter(r.Context(), user.ID, afterID, user.IsDeveloper || user.Permissions["chat.view"])
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось получить уведомления")
			return
		}
		if len(items) > 0 || cursor > afterID || waitSeconds == 0 || !time.Now().Before(deadline) {
			writeJSON(w, http.StatusOK, desktopNotificationResponse{Items: items, NextCursor: cursor, ServerTime: time.Now()})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (a *app) desktopNotificationsAfter(ctx context.Context, userID, afterID int64, allowChat bool) ([]desktopNotification, int64, error) {
	cursor := afterID
	if err := a.db.QueryRowContext(ctx, `
		SELECT COALESCE(max(id),$2) FROM (
			SELECT id FROM desktop_notifications WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT 100
		) pending`, userID, afterID).Scan(&cursor); err != nil {
		return nil, afterID, err
	}
	if cursor == afterID {
		return []desktopNotification{}, cursor, nil
	}
	rows, err := a.db.QueryContext(ctx, `
		SELECT id,kind,title,body,action_url,created_at
		FROM desktop_notifications
		WHERE user_id=$1 AND id>$2 AND id<=$3 AND (kind<>'chat.message' OR $4)
		ORDER BY id
		LIMIT 100`, userID, afterID, cursor, allowChat)
	if err != nil {
		return nil, afterID, err
	}
	defer rows.Close()
	items := []desktopNotification{}
	for rows.Next() {
		var item desktopNotification
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.Body, &item.ActionURL, &item.CreatedAt); err != nil {
			return nil, afterID, err
		}
		items = append(items, item)
	}
	return items, cursor, rows.Err()
}

func (a *app) createDesktopNotification(w http.ResponseWriter, r *http.Request) {
	var input customDesktopNotificationInput
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	if input.Kind == "" {
		input.Kind = "custom"
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.ActionURL = strings.TrimSpace(input.ActionURL)
	if !desktopNotificationKindPattern.MatchString(input.Kind) || utf8.RuneCountInString(input.Title) < 1 || utf8.RuneCountInString(input.Title) > 160 || utf8.RuneCountInString(input.Body) < 1 || utf8.RuneCountInString(input.Body) > 1000 || utf8.RuneCountInString(input.ActionURL) > 1000 || !validDesktopActionURL(input.ActionURL) {
		fail(w, http.StatusBadRequest, "Проверьте тип, заголовок, текст и ссылку уведомления")
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать уведомление")
		return
	}
	defer tx.Rollback()
	created := int64(0)
	if len(input.UserIDs) == 0 {
		result, execErr := tx.ExecContext(r.Context(), `
			INSERT INTO desktop_notifications(user_id,kind,title,body,action_url)
			SELECT id,$1,$2,$3,$4 FROM users WHERE active=true`, input.Kind, input.Title, input.Body, input.ActionURL)
		if execErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось создать уведомление")
			return
		}
		created, _ = result.RowsAffected()
	} else {
		seen := map[int64]bool{}
		for _, userID := range input.UserIDs {
			if userID < 1 || seen[userID] {
				continue
			}
			seen[userID] = true
			result, execErr := tx.ExecContext(r.Context(), `
				INSERT INTO desktop_notifications(user_id,kind,title,body,action_url)
				SELECT id,$2,$3,$4,$5 FROM users WHERE id=$1 AND active=true`, userID, input.Kind, input.Title, input.Body, input.ActionURL)
			if execErr != nil {
				fail(w, http.StatusInternalServerError, "Не удалось создать уведомление")
				return
			}
			count, _ := result.RowsAffected()
			created += count
		}
	}
	if created == 0 {
		fail(w, http.StatusBadRequest, "Не найдено активных получателей")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать уведомление")
		return
	}
	a.audit(r.Context(), currentUser(r).ID, "create", "desktop_notification", nil, map[string]any{"kind": input.Kind, "recipients": created, "action_url": input.ActionURL})
	writeJSON(w, http.StatusCreated, map[string]any{"created": created})
}

func enqueueChatDesktopNotifications(ctx context.Context, tx *sql.Tx, conversationID, messageID, senderID int64, senderName, storedBody string) error {
	var kind string
	var name sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT kind,name FROM chat_conversations WHERE id=$1`, conversationID).Scan(&kind, &name); err != nil {
		return err
	}
	title := chatDesktopNotificationTitle(kind, name.String, senderName)
	body := chatDesktopNotificationPreview(storedBody)
	_, err := tx.ExecContext(ctx, `
		INSERT INTO desktop_notifications(user_id,kind,title,body,action_url,source_key)
		SELECT cm.user_id,'chat.message',$4,$5,$6,$3
		FROM chat_members cm
		JOIN users u ON u.id=cm.user_id AND u.active=true
		WHERE cm.conversation_id=$1 AND cm.user_id<>$2
		ON CONFLICT (user_id,source_key) WHERE source_key IS NOT NULL DO NOTHING`,
		conversationID, senderID, chatDesktopNotificationSourceKey(messageID), title, body,
		fmt.Sprintf("/?page=chat&conversation=%d", conversationID))
	return err
}

func chatDesktopNotificationSourceKey(messageID int64) string {
	return "chat_message:" + strconv.FormatInt(messageID, 10)
}

func (a *app) enqueueChatDesktopNotificationsBestEffort(ctx context.Context, conversationID, messageID, senderID int64, senderName, storedBody string) {
	notificationContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	tx, err := a.db.BeginTx(notificationContext, nil)
	if err == nil {
		err = enqueueChatDesktopNotifications(notificationContext, tx, conversationID, messageID, senderID, senderName, storedBody)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		if tx != nil {
			_ = tx.Rollback()
		}
		log.Printf("desktop notification enqueue failed for conversation=%d message=%d: %v", conversationID, messageID, err)
	}
}

func chatDesktopNotificationTitle(kind, conversationName, senderName string) string {
	if kind == "group" && strings.TrimSpace(conversationName) != "" {
		return truncateRunes(strings.TrimSpace(conversationName)+" · "+strings.TrimSpace(senderName), 160)
	}
	return truncateRunes("Сообщение от "+strings.TrimSpace(senderName), 160)
}

func chatDesktopNotificationPreview(storedBody string) string {
	body, attachment := decodeChatAttachmentBody(storedBody)
	body = strings.Join(strings.Fields(strings.TrimSpace(body)), " ")
	if attachment != nil {
		filePart := "Файл: " + attachment.OriginalName
		if body != "" {
			body = filePart + " — " + body
		} else {
			body = filePart
		}
	}
	if body == "" {
		body = "Новое сообщение"
	}
	return truncateRunes(body, 350)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	if limit < 2 {
		return string(runes[:limit])
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func validDesktopActionURL(value string) bool {
	if value == "" {
		return true
	}
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && !parsed.IsAbs() && parsed.Host == ""
}
