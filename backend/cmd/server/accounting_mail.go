package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	accountingConversationCategory  = "accounting"
	accountingConversationKeyPrefix = "accounting-invoice:"
	maxAccountingSubjectLength      = 120
	maxAccountingDescriptionLength  = 2800
	accountingMailboxRoutingLockKey = int64(73014820260811)
)

func newAccountingConversationKey() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return accountingConversationKeyPrefix + hex.EncodeToString(value), nil
}

func isAccountingConversationKey(value string) bool {
	payload := strings.TrimPrefix(value, accountingConversationKeyPrefix)
	if payload == value || len(payload) != 32 {
		return false
	}
	_, err := hex.DecodeString(payload)
	return err == nil
}

func canReceiveAccountingMail(role string, active bool, permissions permissionSet) bool {
	return active && role == "accountant" && permissions["invoice_mail.inbox"]
}

func accountingMemberLastReadAt(memberID, senderID int64, now time.Time) time.Time {
	if memberID == senderID {
		return now
	}
	return time.Unix(0, 0).UTC()
}

func accountingRecipientFromState(storedRole string, raw []byte) bool {
	profileRole := profileRoleFromState(raw, storedRole)
	return canReceiveAccountingMail(profileRole, true, permissionsFromState(raw, profileRole))
}

func lockAccountingMailboxRouting(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, accountingMailboxRoutingLockKey)
	return err
}

func accountingRecipientIDs(ctx context.Context, tx *sql.Tx, senderID int64) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT u.id,u.role,COALESCE(s.state,'{}'::jsonb)
		FROM users u
		LEFT JOIN user_workspace_state s ON s.user_id=u.id
		WHERE u.active AND u.id<>$1
		ORDER BY u.id`, senderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []int64{}
	for rows.Next() {
		var id int64
		var role string
		var raw []byte
		if err = rows.Scan(&id, &role, &raw); err != nil {
			return nil, err
		}
		if accountingRecipientFromState(role, raw) {
			result = append(result, id)
		}
	}
	return result, rows.Err()
}

func syncAccountingMemberships(ctx context.Context, tx *sql.Tx, userID int64, receives bool) error {
	if !receives {
		// Membership is the immutable delivery history of an accounting invoice.
		// Removing the role must not remove already received invoices.
		return nil
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO chat_members(conversation_id,user_id,last_read_at)
		SELECT id,$2,'epoch'::timestamptz
		FROM chat_conversations
		WHERE direct_key LIKE $1
		ON CONFLICT DO NOTHING`, accountingConversationKeyPrefix+"%", userID)
	return err
}

func (a *app) createAccountingMail(w http.ResponseWriter, r *http.Request) {
	subject := strings.TrimSpace(r.URL.Query().Get("subject"))
	if subject == "" || utf8.RuneCountInString(subject) > maxAccountingSubjectLength {
		fail(w, http.StatusBadRequest, "Укажите тему счёта от 1 до 120 символов")
		return
	}
	sender := currentUser(r)
	conversationKey, err := newAccountingConversationKey()
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить отправку счёта")
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать отправку счёта")
		return
	}
	defer tx.Rollback()
	if err = lockAccountingMailboxRouting(r.Context(), tx); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось зафиксировать список получателей бухгалтерии")
		return
	}
	recipients, err := accountingRecipientIDs(r.Context(), tx, sender.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось определить получателей бухгалтерии")
		return
	}
	if len(recipients) == 0 {
		fail(w, http.StatusConflict, "Не назначен ни один активный сотрудник с ролью «Бухгалтер»")
		return
	}

	var conversationID int64
	if err = tx.QueryRowContext(r.Context(), `
		INSERT INTO chat_conversations(kind,name,direct_key,created_by)
		VALUES('group',$1,$2,$3)
		RETURNING id`, subject, conversationKey, sender.ID).Scan(&conversationID); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось создать отправление в бухгалтерию")
		return
	}
	members := uniqueChatMembers(recipients, sender.ID)
	readAt := time.Now()
	for _, memberID := range members {
		lastReadAt := accountingMemberLastReadAt(memberID, sender.ID, readAt)
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO chat_members(conversation_id,user_id,last_read_at) VALUES($1,$2,$3)`, conversationID, memberID, lastReadAt); err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось назначить получателей бухгалтерии")
			return
		}
	}

	body, attachment, ok := a.readChatMessageInput(w, r, conversationID)
	if !ok {
		return
	}
	if attachment == nil {
		fail(w, http.StatusBadRequest, "Прикрепите файл счёта")
		return
	}
	removeStoredFile := func() {
		_ = os.Remove(filepath.Join(chatImageDirectory(), strconv.FormatInt(conversationID, 10), attachment.StoredName))
	}
	if utf8.RuneCountInString(body) > maxAccountingDescriptionLength {
		removeStoredFile()
		fail(w, http.StatusBadRequest, "Описание должно содержать не больше 2800 символов")
		return
	}
	storedBody := encodeChatAttachmentBody(body, attachment)
	if storedBody == "" || utf8.RuneCountInString(storedBody) > 4000 {
		removeStoredFile()
		fail(w, http.StatusBadRequest, "Описание вместе с данными файла должно содержать не больше 4000 символов")
		return
	}
	var message chatMessage
	err = tx.QueryRowContext(r.Context(), `
		WITH inserted AS (
			INSERT INTO chat_messages(conversation_id,sender_id,body) VALUES($1,$2,$3)
			RETURNING id,conversation_id,sender_id,body,created_at
		)
		SELECT i.id,i.conversation_id,i.sender_id,$4,i.body,to_char(i.created_at,'YYYY-MM-DD HH24:MI:SS')
		FROM inserted i`, conversationID, sender.ID, storedBody, sender.Name).Scan(
		&message.ID, &message.ConversationID, &message.SenderID, &message.SenderName, &message.Body, &message.CreatedAt,
	)
	if err != nil {
		removeStoredFile()
		fail(w, http.StatusInternalServerError, "Не удалось отправить счёт в бухгалтерию")
		return
	}
	if err = enqueueChatDesktopNotifications(r.Context(), tx, conversationID, message.ID, sender.ID, sender.Name, storedBody); err != nil {
		removeStoredFile()
		fail(w, http.StatusInternalServerError, "Не удалось подготовить уведомления получателям")
		return
	}
	if err = tx.Commit(); err != nil {
		removeStoredFile()
		fail(w, http.StatusInternalServerError, "Не удалось завершить отправку счёта")
		return
	}

	applyChatMessagePresentation(&message, conversationID)
	a.audit(r.Context(), sender.ID, "create", "accounting_invoice", &conversationID, map[string]any{"subject": subject, "recipients": len(recipients), "attachment": attachment.OriginalName})
	writeJSON(w, http.StatusCreated, map[string]any{"id": conversationID, "subject": subject, "message": message})
}
