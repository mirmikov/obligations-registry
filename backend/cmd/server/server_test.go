package main

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestObligationNormalizeCalculatesPlannedDate(t *testing.T) {
	days := 10
	input := obligationInput{DocumentDate: "2026-07-01", DefermentDays: &days, PlannedPaymentDate: "2026-12-31"}
	input.normalize()
	if input.PlannedPaymentDate != "2026-07-11" {
		t.Fatalf("planned date = %q, want 2026-07-11", input.PlannedPaymentDate)
	}
	if input.EntryDate == "" {
		t.Fatal("entry date must be populated")
	}
}

func TestPresenceExpiresStaleSessions(t *testing.T) {
	hub := newPresenceHub()
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	hub.update(authUser{ID: 1, Name: "Администратор", Role: "admin"}, presenceInput{SessionID: "session-admin", Page: "registry", Mode: "edit", RecordID: 42, Field: "amount"}, now)
	hub.update(authUser{ID: 2, Name: "Редактор", Role: "editor"}, presenceInput{SessionID: "session-editor", Page: "registry"}, now.Add(-presenceTTL-time.Second))
	items := hub.list(now)
	if len(items) != 1 || items[0].SessionID != "session-admin" {
		t.Fatalf("active presence = %#v", items)
	}
}

func TestPresenceCanOnlyBeRemovedByItsUser(t *testing.T) {
	hub := newPresenceHub()
	now := time.Now()
	hub.update(authUser{ID: 7, Name: "Редактор"}, presenceInput{SessionID: "session-123"}, now)
	hub.remove("session-123", 8)
	if len(hub.list(now)) != 1 {
		t.Fatal("another user removed the session")
	}
	hub.remove("session-123", 7)
	if len(hub.list(now)) != 0 {
		t.Fatal("session owner could not remove the session")
	}
}

func TestBuildFiltersUsesBoundParameters(t *testing.T) {
	r := httptest.NewRequest("GET", "/?status=%D0%9A+%D0%BE%D0%BF%D0%BB%D0%B0%D1%82%D0%B5&q=%D0%94%D0%B5%D0%BB%D1%8C%D1%82%D0%B0&entry_date=2026-07-18&overdue=true", nil)
	where, args := buildFilters(r, 1)
	if len(args) != 3 {
		t.Fatalf("got %d args, want 3", len(args))
	}
	for _, expected := range []string{"status=$1", "$2", "entry_date = $3::date", "planned_payment_date<CURRENT_DATE"} {
		if !strings.Contains(where, expected) {
			t.Fatalf("filter SQL %q does not contain %q", where, expected)
		}
	}
}

func TestBuildFiltersSupportsMultipleCounterparties(t *testing.T) {
	r := httptest.NewRequest("GET", "/?counterparty=Альфа&counterparty=Бета&counterparty=Альфа", nil)
	where, args := buildFilters(r, 1)
	if !strings.Contains(where, "counterparty=ANY($1::text[])") {
		t.Fatalf("filter SQL %q does not use a text array", where)
	}
	values, ok := args[0].([]string)
	if !ok || len(values) != 2 || values[0] != "Альфа" || values[1] != "Бета" {
		t.Fatalf("counterparty args = %#v, want [Альфа Бета]", args[0])
	}
}

func TestNormalizeWorkspaceStateRejectsUnknownPage(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "users<script>", SidebarCollapsed: true})
	if value.Page != "dashboard" || !value.SidebarCollapsed {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestNormalizeWorkspaceStateAcceptsCreditsLeasingReport(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "credits-leasing"})
	if value.Page != "credits-leasing" {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestExcelDateParsing(t *testing.T) {
	for input, expected := range map[string]string{"18.07.2026": "2026-07-18", "2026-07-18": "2026-07-18"} {
		if actual := parseDate(input); actual != expected {
			t.Fatalf("parseDate(%q)=%q, want %q", input, actual, expected)
		}
	}
}

func TestExcelNumberParsingPreservesKopecks(t *testing.T) {
	value := parseFloatPtr("60\u00a0591,67")
	if value == nil || strconv.FormatFloat(*value, 'f', 2, 64) != "60591.67" {
		t.Fatalf("parseFloatPtr() = %v, want 60591.67", value)
	}
}

func TestExcelExportDereferencesNumbers(t *testing.T) {
	days := 10
	amount := 60591.67
	if value, ok := intValue(&days).(int); !ok || value != days {
		t.Fatalf("intValue() = %#v, want numeric %d", intValue(&days), days)
	}
	if value, ok := floatValue(&amount).(float64); !ok || value != amount {
		t.Fatalf("floatValue() = %#v, want numeric %.2f", floatValue(&amount), amount)
	}
}

func TestReferenceKindWhitelist(t *testing.T) {
	if normalizeReferenceKind("statuses") != "statuses" {
		t.Fatal("known reference kind rejected")
	}
	if normalizeReferenceKind("anything'); DROP TABLE users; --") != "" {
		t.Fatal("unknown reference kind accepted")
	}
}

func TestObligationUpdateAcceptsReadOnlySplitMetadata(t *testing.T) {
	req := httptest.NewRequest("PATCH", "/api/obligations/42", strings.NewReader(`{"status":"К оплате","split_group_id":"split-test","split_parent_id":12,"installment_number":2,"installment_count":3}`))
	recorder := httptest.NewRecorder()
	var payload obligationUpdateInput
	if !decodeJSON(recorder, req, &payload) {
		t.Fatalf("split metadata was rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if payload.Status != "К оплате" || payload.SplitGroupID != "split-test" || payload.InstallmentNumber != 2 || payload.InstallmentCount != 3 {
		t.Fatalf("decoded payload = %#v", payload)
	}
}

func TestBuildPaymentPlanKeepsExactTotalAndMonthlyAnchor(t *testing.T) {
	start := time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC)
	plan, err := buildPaymentPlan(10000, start, paymentSplitInput{Mode: "count", Count: 3, PeriodUnit: "month", PeriodValue: 1})
	if err != nil {
		t.Fatal(err)
	}
	wantCents := []int64{3333, 3333, 3334}
	wantDates := []string{"2027-01-31", "2027-02-28", "2027-03-31"}
	var total int64
	for index, installment := range plan {
		if installment.cents != wantCents[index] || installment.Date != wantDates[index] {
			t.Fatalf("installment %d = %#v, want %d cents on %s", index+1, installment, wantCents[index], wantDates[index])
		}
		total += installment.cents
	}
	if total != 10000 {
		t.Fatalf("plan total = %d cents, want 10000", total)
	}
}

func TestBuildPaymentPlanByFixedAmountUsesRemainder(t *testing.T) {
	payment := json.Number("30.00")
	plan, err := buildPaymentPlan(10000, time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC), paymentSplitInput{Mode: "amount", PaymentAmount: &payment, PeriodUnit: "week", PeriodValue: 2})
	if err != nil {
		t.Fatal(err)
	}
	wantCents := []int64{3000, 3000, 3000, 1000}
	wantDates := []string{"2026-07-20", "2026-08-03", "2026-08-17", "2026-08-31"}
	if len(plan) != len(wantCents) {
		t.Fatalf("plan length = %d, want %d", len(plan), len(wantCents))
	}
	for index, installment := range plan {
		if installment.cents != wantCents[index] || installment.Date != wantDates[index] {
			t.Fatalf("installment %d = %#v, want %d cents on %s", index+1, installment, wantCents[index], wantDates[index])
		}
	}
}

func TestMoneyTextToCentsDoesNotLoseLargeAmountKopecks(t *testing.T) {
	cents, err := moneyTextToCents("9999999999999999.99")
	if err != nil {
		t.Fatal(err)
	}
	if cents != 999999999999999999 {
		t.Fatalf("cents = %d, want 999999999999999999", cents)
	}
	if _, err := moneyTextToCents("10.001"); err == nil {
		t.Fatal("amount with fractions of a kopeck must be rejected")
	}
}
