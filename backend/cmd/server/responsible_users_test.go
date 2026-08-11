package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestResponsibleUserReferenceRoundTrip(t *testing.T) {
	encoded := encodeResponsibleUserReference(17, 9)
	value, ok := decodeResponsibleUserReference(encoded)
	if !ok || value.ResponsibleID != 17 || value.UserID != 9 {
		t.Fatalf("decoded mapping = %#v, ok=%v", value, ok)
	}
	if normalizeReferenceKind(responsibleUserReferenceKind) != "" {
		t.Fatal("internal responsible-user mappings must not be editable through generic reference endpoints")
	}
}

func TestResponsibleUserReferenceRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"", `{}`, `{"responsible_id":0,"user_id":9}`, `{"responsible_id":17,"user_id":0}`, `not-json`} {
		if _, ok := decodeResponsibleUserReference(value); ok {
			t.Fatalf("invalid mapping %q was accepted", value)
		}
	}
}

func TestResponsibleNamesForUserFiltersDeduplicatesAndSorts(t *testing.T) {
	stored := []storedResponsibleUserReference{
		{Encoded: encodeResponsibleUserReference(2, 7), ResponsibleID: 2, ResponsibleName: "Петров П.П."},
		{Encoded: encodeResponsibleUserReference(1, 7), ResponsibleID: 1, ResponsibleName: "Иванов И.И."},
		{Encoded: encodeResponsibleUserReference(3, 8), ResponsibleID: 3, ResponsibleName: "Чужой сотрудник"},
		{Encoded: encodeResponsibleUserReference(4, 7), ResponsibleID: 4, ResponsibleName: "Иванов И.И."},
		{Encoded: encodeResponsibleUserReference(5, 7), ResponsibleID: 999, ResponsibleName: "Подменённый"},
		{Encoded: `{}`, ResponsibleID: 6, ResponsibleName: "Некорректный"},
	}
	want := []string{"Иванов И.И.", "Петров П.П."}
	if got := responsibleNamesForUser(7, stored); !reflect.DeepEqual(got, want) {
		t.Fatalf("responsibles = %#v, want %#v", got, want)
	}
}

func TestExistingPermissionStateReceivesMyInvoicesPermission(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"permissions": map[string]bool{"dashboard.view": true}})
	permissions := permissionsFromState(raw, "viewer")
	if !permissions["my_invoices.view"] {
		t.Fatal("existing users must receive the new My invoices permission")
	}

	raw, _ = json.Marshal(map[string]any{"permissions": map[string]bool{"my_invoices.view": false}})
	permissions = permissionsFromState(raw, "viewer")
	if permissions["my_invoices.view"] {
		t.Fatal("an explicitly disabled My invoices permission must stay disabled")
	}
}
