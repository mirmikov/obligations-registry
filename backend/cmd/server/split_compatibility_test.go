package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPaymentSplitInputAcceptsKnownLegacyUIFields(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/obligations/42/split", strings.NewReader(`{
		"mode":"count",
		"count":2,
		"payment_dates":["2026-08-12","2026-09-12"],
		"amount_parts":null,
		"percentage_parts":null,
		"advance_percent":"30",
		"advance_date":"2026-08-12",
		"advance_account_type":"ОМС",
		"balance_date":"2026-09-12",
		"balance_account_type":"Коммерция",
		"calendar_count":"2",
		"calendar_start_date":"2026-08-12",
		"calendar_interval":"1",
		"calendar_unit":"month",
		"recurring_amount":"",
		"recurring_start_date":"2026-08-12",
		"recurring_interval":"1",
		"recurring_unit":"month",
		"recurring_account_type":"ОМС",
		"weight_parts":[{"weight":"1","account_type":"ОМС","planned_date":"2026-08-12"}]
	}`))
	recorder := httptest.NewRecorder()
	input := paymentSplitInput{}

	if !decodeJSON(recorder, request, &input) {
		t.Fatalf("known legacy split fields were rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if input.Mode != "count" || input.Count != 2 || len(input.PaymentDates) != 2 {
		t.Fatalf("core split fields were not decoded: %+v", input)
	}
}

func TestPaymentSplitInputStillRejectsUnknownFields(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/obligations/42/split", strings.NewReader(`{
		"mode":"count",
		"count":2,
		"payment_dates":["2026-08-12","2026-09-12"],
		"rogue_field":"must be rejected"
	}`))
	recorder := httptest.NewRecorder()
	input := paymentSplitInput{}

	if decodeJSON(recorder, request, &input) {
		t.Fatal("an arbitrary unknown field was accepted")
	}
	if recorder.Code != 400 || !strings.Contains(recorder.Body.String(), `unknown field \"rogue_field\"`) {
		t.Fatalf("unexpected rejection response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
