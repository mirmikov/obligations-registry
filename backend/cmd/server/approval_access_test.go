package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestApprovalRoleIsLimitedToManagerAndDeveloper(t *testing.T) {
	if !isManager(authUser{Role: managerRole}) || !isManager(authUser{Role: "developer", IsDeveloper: true}) {
		t.Fatal("manager and developer must be able to approve")
	}
	for _, role := range []string{"admin", "accountant", "editor", "viewer"} {
		if isManager(authUser{Role: role}) {
			t.Fatalf("role %q unexpectedly gained approval access", role)
		}
	}
}

func TestApprovalGuardAllowsUnrelatedEditsButRejectsApproval(t *testing.T) {
	editor := authUser{Role: "editor"}
	previous := obligationApprovalState{ApprovalDate: "2026-08-14", Status: payableStatus}
	unchanged := obligationInput{ApprovalDate: previous.ApprovalDate, Status: previous.Status, Comment: "новый комментарий"}
	if err := validateApprovalUpdate(editor, previous, unchanged); err != nil {
		t.Fatalf("unrelated edit was rejected: %v", err)
	}
	if err := validateApprovalUpdate(editor, obligationApprovalState{}, obligationInput{ApprovalDate: "2026-08-15", Status: payableStatus}); err == nil {
		t.Fatal("editor set an approval date")
	}
	if err := validateApprovalUpdate(editor, obligationApprovalState{ApprovalDate: previous.ApprovalDate}, obligationInput{ApprovalDate: previous.ApprovalDate, Status: payableStatus}); err == nil {
		t.Fatal("editor set payable status")
	}
	if err := validateApprovalCreate(editor, obligationInput{Status: payableStatus}); err == nil {
		t.Fatal("editor created a payable obligation")
	}
	if err := validateApprovalCreate(authUser{Role: managerRole}, obligationInput{ApprovalDate: "2026-08-14", Status: payableStatus}); err != nil {
		t.Fatalf("manager approval was rejected: %v", err)
	}
	if err := validateApprovalCreate(authUser{Role: "developer", IsDeveloper: true}, obligationInput{ApprovalDate: "2026-08-14", Status: payableStatus}); err != nil {
		t.Fatalf("developer approval was rejected: %v", err)
	}
}

func TestApprovalPermissionsCannotBeGrantedToOtherRoles(t *testing.T) {
	requested := permissionSet{"executive.approve": true, "credits.approve": true}
	for _, role := range []string{"admin", "accountant", "editor", "viewer"} {
		permissions := normalizePermissions(requested, role)
		if permissions["executive.approve"] || permissions["credits.approve"] {
			t.Fatalf("role %q retained approval permissions: %#v", role, permissions)
		}
	}
	manager := normalizePermissions(requested, managerRole)
	if !manager["executive.approve"] || !manager["credits.approve"] || !manager["executive.view"] || !manager["credits.view"] {
		t.Fatalf("manager approval dependencies are incomplete: %#v", manager)
	}
	defaults := defaultPermissions(managerRole)
	for _, key := range []string{"registry.edit", "executive.approve", "credits.approve", "payments.edit"} {
		if !defaults[key] {
			t.Fatalf("manager default permissions are missing %q: %#v", key, defaults)
		}
	}
}

func TestManagerProfileUsesViewerStorageRole(t *testing.T) {
	raw := []byte(`{"profile_role":"manager"}`)
	if role := profileRoleFromState(raw, "viewer"); role != managerRole {
		t.Fatalf("manager profile = %q", role)
	}
	if role := profileRoleFromState(raw, "editor"); role != "editor" {
		t.Fatalf("manager profile overrode incompatible storage role: %q", role)
	}
	if got := storedDatabaseRole(managerRole); got != "viewer" {
		t.Fatalf("manager stored role = %q", got)
	}
}

func TestNonManagerUndoCannotRestoreApproval(t *testing.T) {
	before, _ := json.Marshal([]map[string]any{{"id": 7, "approval_date": "2026-08-14", "status": payableStatus}})
	after, _ := json.Marshal([]map[string]any{{"id": 7, "approval_date": "", "status": "Зарегистрирован"}})
	err := validateApprovalUndo(authUser{Role: "editor"}, &undoChange{Before: before, After: after})
	if err == nil || !strings.Contains(err.Error(), "руководитель") {
		t.Fatalf("approval undo was not rejected: %v", err)
	}
}
