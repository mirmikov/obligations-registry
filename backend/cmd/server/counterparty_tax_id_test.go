package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestCounterpartyTaxIDReassignmentAllowsArchivedConflict(t *testing.T) {
	conflict := &counterpartyTaxIDConflict{ID: 48, Value: "ЧОП СПАС", Active: false}
	reassignment, err := counterpartyTaxIDReassignment(conflict, "4401095511")
	if err != nil {
		t.Fatalf("archived conflict must be transferable: %v", err)
	}
	if reassignment != conflict {
		t.Fatalf("expected archived conflict to be returned, got %#v", reassignment)
	}
}

func TestCounterpartyTaxIDReassignmentRejectsActiveConflict(t *testing.T) {
	conflict := &counterpartyTaxIDConflict{ID: 77, Value: "Другой действующий контрагент", Active: true}
	reassignment, err := counterpartyTaxIDReassignment(conflict, "4401095511")
	if reassignment != nil {
		t.Fatalf("active conflict must not be transferable: %#v", reassignment)
	}
	if err == nil || !strings.Contains(err.Error(), "Другой действующий контрагент") {
		t.Fatalf("expected visible active-conflict error, got %v", err)
	}
}

func TestCounterpartyTaxIDReassignmentHasNoWorkWithoutConflict(t *testing.T) {
	reassignment, err := counterpartyTaxIDReassignment(nil, "4401095511")
	if err != nil || reassignment != nil {
		t.Fatalf("expected no reassignment, got %#v, %v", reassignment, err)
	}
}

func TestNormalizeCounterpartyAliases(t *testing.T) {
	actual := normalizeCounterpartyAliases(
		"ООО \"Частное охранное предприятие \"",
		[]string{" ЧОП СПАС ", "ООО \"Частное охранное предприятие \"", "чоп спас", ""},
	)
	expected := []string{"ЧОП СПАС"}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("expected %#v, got %#v", expected, actual)
	}
}
