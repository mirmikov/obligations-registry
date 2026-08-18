package main

import (
	"strings"
	"testing"
)

func TestPaymentRegisterStatusWhereKeepsPaidRowsInDefaultSlice(t *testing.T) {
	where := paymentRegisterStatusWhere("TRUE", "")
	for _, status := range []string{"К оплате", "Оплачено"} {
		if !strings.Contains(where, status) {
			t.Fatalf("default payment register filter does not contain %q: %s", status, where)
		}
	}
	if strings.Contains(where, "Отменено") || strings.Contains(where, "Зарегистрирован") {
		t.Fatalf("default payment register filter contains an unrelated status: %s", where)
	}
}

func TestPaymentRegisterStatusWherePreservesExplicitStatusFilter(t *testing.T) {
	const initial = "TRUE AND status=$1"
	if got := paymentRegisterStatusWhere(initial, "Оплачено"); got != initial {
		t.Fatalf("explicit status filter changed: %s", got)
	}
	if got := paymentRegisterStatusWhere(initial, "  К оплате  "); got != initial {
		t.Fatalf("trimmed explicit status filter changed: %s", got)
	}
}
