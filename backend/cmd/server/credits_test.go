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
