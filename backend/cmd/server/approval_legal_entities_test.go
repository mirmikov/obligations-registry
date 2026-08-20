package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func scopedManager(entities ...string) authUser {
	return authUser{
		Role:                  managerRole,
		Permissions:           permissionSet{"obligations.approve": true},
		ApprovalLegalEntities: entities,
	}
}

func TestManagerCanApproveMultipleConfiguredLegalEntities(t *testing.T) {
	manager := scopedManager("ООО МЦ Мирт", "ООО Клиника Мирт")
	for _, entity := range manager.ApprovalLegalEntities {
		if !canApproveLegalEntity(manager, entity) {
			t.Fatalf("configured entity %q was rejected", entity)
		}
		input := obligationInput{LegalEntity: entity, ApprovalDate: "2026-08-20", Status: payableStatus}
		if err := validateApprovalCreate(manager, input); err != nil {
			t.Fatalf("configured entity %q approval failed: %v", entity, err)
		}
	}
}

func TestEditorCanApproveMultipleConfiguredLegalEntities(t *testing.T) {
	editor := authUser{
		Role:                  "editor",
		Permissions:           permissionSet{"obligations.approve": true},
		ApprovalLegalEntities: []string{"ООО МЦ Мирт", "ООО Клиника Мирт"},
	}
	for _, entity := range editor.ApprovalLegalEntities {
		input := obligationInput{LegalEntity: entity, ApprovalDate: "2026-08-20", Status: payableStatus}
		if err := validateApprovalCreate(editor, input); err != nil {
			t.Fatalf("configured editor approval for %q failed: %v", entity, err)
		}
	}
}

func TestManagerCannotApproveUnconfiguredLegalEntity(t *testing.T) {
	manager := scopedManager("ООО МЦ Мирт", "ООО Клиника Мирт")
	input := obligationInput{LegalEntity: "ООО Стоматология", ApprovalDate: "2026-08-20", Status: payableStatus}
	err := validateApprovalCreate(manager, input)
	if err == nil || !strings.Contains(err.Error(), "ООО Стоматология") {
		t.Fatalf("unconfigured entity was not rejected clearly: %v", err)
	}
	previous := obligationApprovalState{LegalEntity: input.LegalEntity, Status: "Зарегистрирован"}
	if err = validateApprovalUpdate(manager, previous, input); err == nil {
		t.Fatal("manager changed an unconfigured entity to payable")
	}
}

func TestApprovedPaymentCannotBeMovedToUnauthorizedLegalEntity(t *testing.T) {
	manager := scopedManager("ООО МЦ Мирт")
	previous := obligationApprovalState{LegalEntity: "ООО МЦ Мирт", ApprovalDate: "2026-08-20", Status: payableStatus}
	next := obligationInput{LegalEntity: "ООО Стоматология", ApprovalDate: previous.ApprovalDate, Status: previous.Status}
	if err := validateApprovalUpdate(manager, previous, next); err == nil {
		t.Fatal("approved payment moved to an unauthorized legal entity")
	}
	editor := authUser{Role: "editor", Permissions: permissionSet{"registry.edit": true}}
	if err := validateApprovalUpdate(editor, previous, next); err == nil {
		t.Fatal("editor moved an approved payment between legal entities")
	}
}

func TestEmptyEntityScopeKeepsAllEntitiesForBackwardCompatibility(t *testing.T) {
	manager := scopedManager()
	if !canApproveLegalEntity(manager, "Любое действующее юрлицо") {
		t.Fatal("empty scope must mean all legal entities")
	}
	developer := authUser{Role: "developer", IsDeveloper: true, ApprovalLegalEntities: []string{"Ограничение не применяется"}}
	if !canApproveLegalEntity(developer, "Другое юрлицо") {
		t.Fatal("developer must always approve every legal entity")
	}
}

func TestApprovalLegalEntityStateIsNormalized(t *testing.T) {
	raw := []byte(`{"approval_legal_entities":[" ООО МЦ Мирт ","ооо мц мирт","ООО Клиника Мирт",""]}`)
	expected := []string{"ООО МЦ Мирт", "ООО Клиника Мирт"}
	if actual := approvalLegalEntitiesFromState(raw); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("expected %#v, got %#v", expected, actual)
	}
}

func TestAuthPayloadContainsApprovalLegalEntities(t *testing.T) {
	raw, err := json.Marshal(scopedManager("ООО МЦ Мирт", "ООО Клиника Мирт"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"approval_legal_entities":["ООО МЦ Мирт","ООО Клиника Мирт"]`) {
		t.Fatalf("approval scope missing from auth payload: %s", raw)
	}
}

func TestBulkApprovalScopeCheckOnlyRunsForApprovalChanges(t *testing.T) {
	if !approvalBulkUpdateRequested(bulkUpdateInput{ApprovalDateSet: true}) ||
		!approvalBulkUpdateRequested(bulkUpdateInput{Status: payableStatus}) ||
		!approvalBulkUpdateRequested(bulkUpdateInput{ApprovalDate: "2026-08-20"}) {
		t.Fatal("approval changes must trigger legal-entity scope validation")
	}
	if approvalBulkUpdateRequested(bulkUpdateInput{Status: "Оплачено", ActualPaymentDate: "2026-08-20"}) {
		t.Fatal("payment completion is not an approval action")
	}
}
