package main

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestPriorityCenterFiltersAreParameterizedAndSupportBlankValues(t *testing.T) {
	query := url.Values{
		"scope": {"overdue"}, "urgency": {blankAccountTypeFilter}, "priority": {"Высокий"},
		"legal_entity": {"ООО Мирт"}, "q": {"счёт 17"},
	}
	where, args := buildPriorityCenterFilters(query)
	for _, fragment := range []string{"NULLIF(BTRIM(urgency),'') IS NULL", "priority=$2", "legal_entity=$1", "ILIKE", "planned_payment_date<CURRENT_DATE"} {
		if !strings.Contains(where, fragment) {
			t.Fatalf("filter %q missing from %q", fragment, where)
		}
	}
	if !reflect.DeepEqual(args, []any{"ООО Мирт", "Высокий", "счёт 17"}) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestPriorityCenterDefaultScopeExcludesClosedPayments(t *testing.T) {
	where, args := buildPriorityCenterFilters(url.Values{})
	if len(args) != 0 || !strings.Contains(where, "NOT IN ('Оплачено','Отменено')") {
		t.Fatalf("default active scope is unsafe: %q %#v", where, args)
	}
	all, _ := buildPriorityCenterFilters(url.Values{"scope": {"all"}})
	if strings.Contains(all, "NOT IN ('Оплачено','Отменено')") {
		t.Fatalf("all scope still excludes closed payments: %q", all)
	}
}
