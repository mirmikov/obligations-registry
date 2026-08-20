package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestApprovalRoleAllowsConfiguredManagerEditorAndDeveloper(t *testing.T) {
	if !isManager(authUser{Role: managerRole, Permissions: permissionSet{"obligations.approve": true}}) ||
		!isManager(authUser{Role: "editor", Permissions: permissionSet{"obligations.approve": true}}) ||
		!isManager(authUser{Role: "developer", IsDeveloper: true}) {
		t.Fatal("configured manager, configured editor and developer must be able to approve")
	}
	if isManager(authUser{Role: managerRole}) {
		t.Fatal("manager without the configurable approval permission was allowed")
	}
	if isManager(authUser{Role: "editor"}) {
		t.Fatal("editor without the configurable approval permission was allowed")
	}
	for _, role := range []string{"admin", "accountant", "viewer"} {
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
	if err := validateApprovalCreate(authUser{Role: managerRole, Permissions: permissionSet{"obligations.approve": true}}, obligationInput{ApprovalDate: "2026-08-14", Status: payableStatus}); err != nil {
		t.Fatalf("manager approval was rejected: %v", err)
	}
	if err := validateApprovalCreate(authUser{Role: "developer", IsDeveloper: true}, obligationInput{ApprovalDate: "2026-08-14", Status: payableStatus}); err != nil {
		t.Fatalf("developer approval was rejected: %v", err)
	}
}

func TestApprovalPermissionsCanBeGrantedOnlyToManagerOrEditor(t *testing.T) {
	requested := permissionSet{"executive.approve": true, "credits.approve": true}
	for _, role := range []string{"admin", "accountant", "viewer"} {
		permissions := normalizePermissions(requested, role)
		if permissions["executive.approve"] || permissions["credits.approve"] {
			t.Fatalf("role %q retained approval permissions: %#v", role, permissions)
		}
	}
	editor := normalizePermissions(requested, "editor")
	if !editor["executive.approve"] || !editor["credits.approve"] || !editor["obligations.approve"] || !editor["executive.view"] || !editor["credits.view"] {
		t.Fatalf("editor approval dependencies are incomplete: %#v", editor)
	}
	manager := normalizePermissions(requested, managerRole)
	if !manager["executive.approve"] || !manager["credits.approve"] || !manager["obligations.approve"] || !manager["executive.view"] || !manager["credits.view"] {
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

func TestProfileRoleUpsertCastsJSONArgument(t *testing.T) {
	if !strings.Contains(profileRoleUpsertSQL, "jsonb_build_object('profile_role',$2::text)") || !strings.Contains(profileRoleUpsertSQL, "to_jsonb($2::text)") {
		t.Fatalf("profile role query can leave PostgreSQL parameter type ambiguous: %s", profileRoleUpsertSQL)
	}
}

func TestManagerPermissionAdministrationIsConfigurable(t *testing.T) {
	manager := authUser{Role: managerRole, Permissions: permissionSet{"users.permissions": true}}
	if !canConfigureUserPermissions(manager) {
		t.Fatal("manager with users.permissions cannot configure access")
	}
	if canConfigureUserPermissions(authUser{Role: managerRole}) {
		t.Fatal("manager without users.permissions can configure access")
	}
}

func TestApprovalPermissionsRemainConfigurableForManagerAndEditorOnly(t *testing.T) {
	requested := permissionSet{
		"obligations.approve":     true,
		"executive.approve":       true,
		"credits.approve":         true,
		"priority_center.approve": true,
	}
	for _, role := range []string{"admin", "accountant", "viewer"} {
		permissions := normalizePermissions(requested, role)
		for key := range requested {
			if permissions[key] {
				t.Fatalf("%s retained manager-only permission %s", role, key)
			}
		}
	}
	editor := normalizePermissions(requested, "editor")
	for key := range requested {
		if !editor[key] {
			t.Fatalf("editor lost configured approval permission %s", key)
		}
	}

	manager := normalizePermissions(requested, managerRole)
	for key := range requested {
		if !manager[key] {
			t.Fatalf("manager lost configured approval permission %s", key)
		}
	}
}

func TestStoredEditorScopeRestoresApprovalPermission(t *testing.T) {
	raw := []byte(`{"permissions":{"registry.edit":true,"obligations.approve":false},"approval_legal_entities":["ООО Мирт-Фарм"]}`)
	permissions := permissionsFromState(raw, "editor")
	if !permissions["obligations.approve"] || !permissions["registry.view"] {
		t.Fatalf("stored editor scope did not restore approval access: %#v", permissions)
	}
	editor := authUser{Role: "editor", Permissions: permissions, ApprovalLegalEntities: approvalLegalEntitiesFromState(raw)}
	if err := validateApprovalCreate(editor, obligationInput{LegalEntity: "ООО Мирт-Фарм", ApprovalDate: "2026-08-20", Status: payableStatus}); err != nil {
		t.Fatalf("editor with a stored scope cannot approve its legal entity: %v", err)
	}

	withoutScope := permissionsFromState([]byte(`{"permissions":{"obligations.approve":false}}`), "editor")
	if withoutScope["obligations.approve"] {
		t.Fatal("editor without a configured scope unexpectedly gained approval access")
	}
	viewer := permissionsFromState(raw, "viewer")
	if viewer["obligations.approve"] {
		t.Fatal("approval scope granted approval access to an unsupported role")
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
