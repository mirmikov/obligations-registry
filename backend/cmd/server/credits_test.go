package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreditsLeasingDetailsRejectsInvalidDateBeforeDatabaseQuery(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/reports/credits-leasing/details?date=11.08.2026&legal_entity=ООО+МИРТ", nil)
	(&app{}).creditsLeasingDetails(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "Некорректная дата платежа") {
		t.Fatalf("unexpected response: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSelectCreditsLeasingEntitySupportsAllEntities(t *testing.T) {
	entities := []creditsLeasingEntity{{Name: "ООО А"}, {Name: "ООО Б"}}
	if got := selectCreditsLeasingEntity("", entities); got != "" {
		t.Fatalf("all-entities selection = %q, want empty", got)
	}
	if got := selectCreditsLeasingEntity("ООО Б", entities); got != "ООО Б" {
		t.Fatalf("valid selection = %q", got)
	}
	if got := selectCreditsLeasingEntity("Несуществующее", entities); got != "ООО А" {
		t.Fatalf("invalid selection fallback = %q", got)
	}
}

func TestCreditsLeasingDetailsScopeSupportsAllEntities(t *testing.T) {
	where, args := creditsLeasingDetailsScope("", "2026-08-11", []string{"Банк А"})
	if strings.Contains(where, "legal_entity") {
		t.Fatalf("all-entities scope must not filter legal entity: %s", where)
	}
	if !strings.Contains(where, "counterparty,'Не указан')=ANY($3::text[])") {
		t.Fatalf("unexpected counterparty placeholder: %s", where)
	}
	if len(args) != 3 || args[1] != "2026-08-11" {
		t.Fatalf("unexpected all-entities args: %#v", args)
	}

	where, args = creditsLeasingDetailsScope("ООО А", "2026-08-11", []string{"Банк А"})
	if !strings.Contains(where, "legal_entity,'Не указано')=$3") || !strings.Contains(where, "counterparty,'Не указан')=ANY($4::text[])") {
		t.Fatalf("unexpected entity scope: %s", where)
	}
	if len(args) != 4 || args[2] != "ООО А" {
		t.Fatalf("unexpected entity args: %#v", args)
	}
}

func TestCreditsLeasingApprovalRejectsPaymentFieldsBeforeDatabaseQuery(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/reports/credits-leasing/obligations/bulk", strings.NewReader(`{"ids":[1],"actual_payment_date":"2026-08-11"}`))
	(&app{}).creditsLeasingBulkUpdate(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "только статус согласования и дату утверждения") {
		t.Fatalf("unexpected response: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestCreditsLeasingApprovalRejectsUnsupportedStatusBeforeDatabaseQuery(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/reports/credits-leasing/obligations/bulk", strings.NewReader(`{"ids":[1],"status":"Оплачено"}`))
	(&app{}).creditsLeasingBulkUpdate(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestUniqueIDCountIgnoresDuplicates(t *testing.T) {
	if count := uniqueIDCount([]int64{1, 2, 1, 3, 2}); count != 3 {
		t.Fatalf("unique ID count = %d, want 3", count)
	}
}
