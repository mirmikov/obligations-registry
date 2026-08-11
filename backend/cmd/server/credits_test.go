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

func TestCreditsLeasingDetailsRequiresLegalEntityBeforeDatabaseQuery(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/reports/credits-leasing/details?date=2026-08-11", nil)
	(&app{}).creditsLeasingDetails(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "Не указано юридическое лицо") {
		t.Fatalf("unexpected response: %d %s", recorder.Code, recorder.Body.String())
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
