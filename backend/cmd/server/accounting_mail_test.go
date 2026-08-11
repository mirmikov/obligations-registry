package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func accountingState(t *testing.T, profileRole string, permissions permissionSet) []byte {
	t.Helper()
	value := map[string]any{}
	if profileRole != "" {
		value["profile_role"] = profileRole
	}
	if permissions != nil {
		value["permissions"] = permissions
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAccountingConversationKeyIsPrivateAndValidated(t *testing.T) {
	first, err := newAccountingConversationKey()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newAccountingConversationKey()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("accounting conversation keys must be unique")
	}
	if !isAccountingConversationKey(first) || !isAccountingConversationKey(second) {
		t.Fatalf("generated keys were rejected: %q, %q", first, second)
	}
	for _, invalid := range []string{
		"",
		"1:2",
		accountingConversationKeyPrefix,
		accountingConversationKeyPrefix + "0123456789abcdef",
		accountingConversationKeyPrefix + "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
		accountingConversationKeyPrefix + "0123456789abcdef0123456789abcdef-extra",
	} {
		if isAccountingConversationKey(invalid) {
			t.Fatalf("invalid accounting key accepted: %q", invalid)
		}
	}
}

func TestLogicalAccountantProfileRequiresEditorStorageRole(t *testing.T) {
	raw := accountingState(t, "accountant", nil)
	if role := profileRoleFromState(raw, "editor"); role != "accountant" {
		t.Fatalf("logical role = %q, want accountant", role)
	}
	for _, storedRole := range []string{"admin", "viewer"} {
		if role := profileRoleFromState(raw, storedRole); role != storedRole {
			t.Fatalf("profile overrode incompatible stored role %q with %q", storedRole, role)
		}
	}
	if role := profileRoleFromState([]byte(`{"profile_role":"developer"}`), "editor"); role != "editor" {
		t.Fatalf("unknown profile role was accepted as %q", role)
	}
}

func TestAccountantPresetAndRecipientSemantics(t *testing.T) {
	accountant := defaultPermissions("accountant")
	if !accountant["invoice_mail.inbox"] || !accountant["invoice_mail.send"] || !accountant["chat.view"] || !accountant["chat.send"] {
		t.Fatalf("accountant preset is incomplete: %#v", accountant)
	}
	if !canReceiveAccountingMail("accountant", true, accountant) {
		t.Fatal("active accountant with inbox permission was rejected")
	}
	if canReceiveAccountingMail("accountant", false, accountant) {
		t.Fatal("inactive accountant was accepted")
	}
	if canReceiveAccountingMail("developer", true, fullPermissions()) {
		t.Fatal("developer became an accounting recipient only because all permissions are enabled")
	}
	if canReceiveAccountingMail("admin", true, fullPermissions()) {
		t.Fatal("administrator became an accounting recipient without the accountant profile")
	}
	if canReceiveAccountingMail("accountant", true, permissionSet{"invoice_mail.inbox": false}) {
		t.Fatal("accountant without inbox permission was accepted")
	}
}

func TestAccountingRecipientMustHaveProfileAndInboxPermission(t *testing.T) {
	if !accountingRecipientFromState("editor", accountingState(t, "accountant", nil)) {
		t.Fatal("accountant profile with its default permissions was not selected")
	}
	if accountingRecipientFromState("admin", accountingState(t, "", fullPermissions())) {
		t.Fatal("developer/admin-style full permissions selected a recipient without an accountant profile")
	}
	if accountingRecipientFromState("editor", accountingState(t, "", permissionSet{"invoice_mail.inbox": true})) {
		t.Fatal("inbox permission without an accountant profile selected a recipient")
	}
	if accountingRecipientFromState("editor", accountingState(t, "accountant", permissionSet{"invoice_mail.inbox": false})) {
		t.Fatal("explicitly disabled accountant inbox was ignored")
	}
}

func TestNonAccountantPermissionsCannotRetainAccountingInbox(t *testing.T) {
	for _, role := range []string{"admin", "editor", "viewer"} {
		permissions := normalizePermissions(permissionSet{"invoice_mail.inbox": true}, role)
		if permissions["invoice_mail.inbox"] || permissions["chat.send"] || permissions["chat.view"] {
			t.Fatalf("role %q retained accountant-only access: %#v", role, permissions)
		}
	}
}

func TestAccountingRecipientsStartUnreadAndSenderStartsRead(t *testing.T) {
	now := time.Date(2026, 8, 11, 18, 30, 0, 0, time.FixedZone("MSK", 3*60*60))
	if got := accountingMemberLastReadAt(7, 7, now); !got.Equal(now) {
		t.Fatalf("sender last_read_at = %s, want %s", got, now)
	}
	wantEpoch := time.Unix(0, 0).UTC()
	if got := accountingMemberLastReadAt(9, 7, now); !got.Equal(wantEpoch) {
		t.Fatalf("recipient last_read_at = %s, want epoch", got)
	}
}

func TestRemovingAccountantRoleDoesNotDeleteDeliveryHistory(t *testing.T) {
	// A nil transaction is intentional: the false branch must be a no-op. If
	// role removal ever starts issuing DELETE/UPDATE statements, this test will
	// panic or fail and protect the immutable delivery history.
	if err := syncAccountingMemberships(context.Background(), nil, 42, false); err != nil {
		t.Fatalf("role removal touched accounting memberships: %v", err)
	}
}
