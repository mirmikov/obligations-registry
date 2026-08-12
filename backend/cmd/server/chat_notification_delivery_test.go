package main

import (
	"os"
	"strings"
	"testing"
)

func TestDesktopNotificationsCannotBlockChatDelivery(t *testing.T) {
	chatSource, err := os.ReadFile("chat.go")
	if err != nil {
		t.Fatal(err)
	}
	chat := sourceFunction(string(chatSource), "func (a *app) sendChatMessage", "func (a *app) readChatMessageInput")
	messageInsert := strings.Index(chat, "err := a.db.QueryRowContext")
	notification := strings.Index(chat, "a.enqueueChatDesktopNotificationsBestEffort")
	response := strings.Index(chat, "writeJSON(w, http.StatusCreated, item)")
	if messageInsert < 0 || notification < messageInsert || response < notification {
		t.Fatal("ordinary chat must persist its message before best-effort desktop notification delivery")
	}

	accountingSource, err := os.ReadFile("accounting_mail.go")
	if err != nil {
		t.Fatal(err)
	}
	accounting := sourceFunction(string(accountingSource), "func (a *app) createAccountingMail", "func uniqueChatMembers")
	commit := strings.Index(accounting, "if err = tx.Commit(); err != nil")
	accountingNotification := strings.Index(accounting, "a.enqueueChatDesktopNotificationsBestEffort")
	if commit < 0 || accountingNotification < commit {
		t.Fatal("accounting invoice must commit before best-effort desktop notification delivery")
	}
	if strings.Contains(accounting[:commit], "enqueueChatDesktopNotifications(") {
		t.Fatal("desktop notifications must not participate in the accounting invoice transaction")
	}
}

func sourceFunction(source, startMarker, endMarker string) string {
	start := strings.Index(source, startMarker)
	if start < 0 {
		return ""
	}
	end := strings.Index(source[start:], endMarker)
	if end < 0 {
		return source[start:]
	}
	return source[start : start+end]
}
