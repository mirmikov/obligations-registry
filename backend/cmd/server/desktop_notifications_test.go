package main

import (
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestDesktopTokenAudienceIsSeparatedFromWebSession(t *testing.T) {
	web := jwt.MapClaims{"sub": "1"}
	desktop := jwt.MapClaims{"sub": "1", "aud": desktopTokenAudience}
	if !tokenAudienceAllowed(web, "") || tokenAudienceAllowed(web, desktopTokenAudience) {
		t.Fatal("web token audience isolation is broken")
	}
	if !tokenAudienceAllowed(desktop, desktopTokenAudience) || tokenAudienceAllowed(desktop, "") {
		t.Fatal("desktop token must be accepted only by desktop endpoints")
	}
	if tokenAudienceAllowed(jwt.MapClaims{"aud": []string{desktopTokenAudience, "other"}}, desktopTokenAudience) {
		t.Fatal("multi-audience token must be rejected")
	}
}

func TestChatDesktopNotificationSourceKeyUsesTextValue(t *testing.T) {
	if got := chatDesktopNotificationSourceKey(108); got != "chat_message:108" {
		t.Fatalf("unexpected source key: %q", got)
	}
}

func TestDesktopActionURLAcceptsOnlySameSitePaths(t *testing.T) {
	for _, value := range []string{"", "/", "/?page=chat&conversation=17", "/registry/42"} {
		if !validDesktopActionURL(value) {
			t.Fatalf("safe action URL %q was rejected", value)
		}
	}
	for _, value := range []string{"https://example.org", "//example.org/path", "javascript:alert(1)", "/ok\r\nX-Test: bad"} {
		if validDesktopActionURL(value) {
			t.Fatalf("unsafe action URL %q was accepted", value)
		}
	}
}

func TestChatDesktopNotificationPresentation(t *testing.T) {
	attachment := &chatAttachment{StoredName: "0123456789abcdef0123456789abcdef.pdf", OriginalName: "Счёт № 17.pdf", ContentType: "application/pdf", Size: 100}
	preview := chatDesktopNotificationPreview(encodeChatAttachmentBody("Проверьте документ", attachment))
	if preview != "Файл: Счёт № 17.pdf — Проверьте документ" {
		t.Fatalf("notification preview = %q", preview)
	}
	if title := chatDesktopNotificationTitle("group", "Бухгалтерия", "Иван"); title != "Бухгалтерия · Иван" {
		t.Fatalf("group title = %q", title)
	}
	if title := chatDesktopNotificationTitle("direct", "ignored", "Ольга"); title != "Сообщение от Ольга" {
		t.Fatalf("direct title = %q", title)
	}
	long := chatDesktopNotificationPreview(strings.Repeat("я", 500))
	if len([]rune(long)) != 350 || !strings.HasSuffix(long, "…") {
		t.Fatalf("long preview was not safely truncated: %d runes", len([]rune(long)))
	}
}
