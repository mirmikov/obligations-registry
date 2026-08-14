package main

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestPriorityCenterFiltersUrgentRegisteredPaymentsByDefault(t *testing.T) {
	where, args := buildPriorityCenterFilters(url.Values{})
	for _, fragment := range []string{"Зарегистрирован", "planned_payment_date<=CURRENT_DATE+6", "urgency", "priority"} {
		if !strings.Contains(where, fragment) {
			t.Fatalf("urgent filter %q missing from %q", fragment, where)
		}
	}
	if len(args) != 0 {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestPriorityCenterFiltersAreParameterizedAndSupportBlankValues(t *testing.T) {
	query := url.Values{"scope": {"overdue"}, "status": {"all"}, "urgency": {blankAccountTypeFilter}, "priority": {"Высокий"}, "legal_entity": {"ООО Мирт"}, "q": {"счёт 17"}}
	where, args := buildPriorityCenterFilters(query)
	for _, fragment := range []string{"NULLIF(BTRIM(urgency),'') IS NULL", "priority=$2", "legal_entity=$1", "ILIKE", "planned_payment_date<CURRENT_DATE", "NOT IN ('Оплачено','Отменено')"} {
		if !strings.Contains(where, fragment) {
			t.Fatalf("filter %q missing from %q", fragment, where)
		}
	}
	if !reflect.DeepEqual(args, []any{"ООО Мирт", "Высокий", "счёт 17"}) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestPriorityApprovalIDsArePositiveAndUnique(t *testing.T) {
	if got := uniquePositiveIDs([]int64{0, 7, 7, -2, 9}); !reflect.DeepEqual(got, []int64{7, 9}) {
		t.Fatalf("unique ids = %#v", got)
	}
}
