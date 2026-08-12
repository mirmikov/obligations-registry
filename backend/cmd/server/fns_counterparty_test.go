package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidateFNSTaxID(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    string
		wantErr bool
	}{
		{name: "legal entity", value: "7707 083893", want: "7707083893"},
		{name: "individual entrepreneur", value: "500100732259", want: "500100732259"},
		{name: "bad legal checksum", value: "7707083894", wantErr: true},
		{name: "bad entrepreneur checksum", value: "500100732258", wantErr: true},
		{name: "empty", value: "", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := validateFNSTaxID(test.value)
			if test.wantErr {
				if err == nil {
					t.Fatal("expected validation error")
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("validateFNSTaxID() = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestFNSLookupLegalEntityUsesOfficialLiveResponse(t *testing.T) {
	var searchPolls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method %s", r.Method)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case "/search-proc.json":
			if r.Form.Get("method") == "get-response" {
				searchPolls.Add(1)
				writeTestJSON(t, w, map[string]any{"ul": map[string]any{"data": []map[string]any{{
					"namec": "ПАО СБЕРБАНК", "namep": "ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО \"СБЕРБАНК РОССИИ\"",
					"inn": "7707083893", "ogrn": "1027700132195", "dtogrn": "16.08.2002", "regionname": "Г.МОСКВА",
					"sulst_ex": 10, "sulst_name_ex": "Действующая организация", "invalid": 0,
					"okved2main": "64.19", "okved2mainname": "Денежное посредничество прочее", "token": "company-token",
				}}}})
				return
			}
			if r.Form.Get("queryAll") != "7707083893" || r.Form.Get("mode") != "search-all" {
				t.Fatalf("unexpected FNS search form: %v", r.Form)
			}
			writeTestJSON(t, w, map[string]any{"id": "search-id", "captchaRequired": false})
		case "/company-proc.json":
			if r.Form.Get("method") == "get-request" {
				if r.Form.Get("token") != "company-token" {
					t.Fatalf("unexpected company token: %s", r.Form.Get("token"))
				}
				writeTestJSON(t, w, map[string]any{"id": "company-id", "token": "response-token"})
				return
			}
			writeTestJSON(t, w, map[string]any{"type": 1, "liquidated": false, "vyp": map[string]any{
				"НаимЮЛСокр": "ПАО СБЕРБАНК", "НаимЮЛПолн": "ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО \"СБЕРБАНК РОССИИ\"",
				"ИНН": "7707083893", "КПП": "773601001", "ОГРН": "1027700132195", "ДатаРег": "20.06.1991",
				"АдресРФ": "117312, Г.МОСКВА, УЛ. ВАВИЛОВА, Д.19", "КодОКВЭД": "64.19", "НаимОКВЭД": "Денежное посредничество прочее",
				"ДатаВып": "07.08.2026", "sulst_name_ex": "Действующая организация", "sulst_ex": 10, "invalid": 0,
				"masruk": []map[string]any{{"name": "ГРЕФ ГЕРМАН ОСКАРОВИЧ", "position": "ПРЕЗИДЕНТ, ПРЕДСЕДАТЕЛЬ ПРАВЛЕНИЯ"}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := &fnsCounterpartyClient{baseURL: server.URL, timeout: 3 * time.Second, limit: make(chan struct{}, 2)}
	result, err := client.lookup(context.Background(), "7707083893")
	if err != nil {
		t.Fatal(err)
	}
	if searchPolls.Load() != 1 {
		t.Fatalf("search polls = %d, want 1", searchPolls.Load())
	}
	if result.EntityType != "legal_entity" || result.SuggestedName != "ПАО СБЕРБАНК" || result.KPP != "773601001" {
		t.Fatalf("unexpected company identity: %+v", result)
	}
	if result.RegistrationDate != "1991-06-20" || result.RegistryUpdatedAt != "2026-08-07" || !result.Active || result.Invalid {
		t.Fatalf("unexpected company status/dates: %+v", result)
	}
	if result.Director == nil || result.Director.Name != "ГРЕФ ГЕРМАН ОСКАРОВИЧ" {
		t.Fatalf("unexpected director: %+v", result.Director)
	}
	if !strings.Contains(result.SourceURL, "pb.nalog.ru") || len(result.Warnings) != 0 {
		t.Fatalf("unexpected source/warnings: %+v", result)
	}
}

func TestFNSLookupIndividualEntrepreneurFallsBackToSearchCard(t *testing.T) {
	server := newFNSTestServer(t,
		map[string]any{"ip": map[string]any{"data": []map[string]any{{
			"namec": "ИВАНОВ ИВАН ИВАНОВИЧ", "inn": "500100732259", "ogrn": "304500100000001", "dtogrn": "01.01.2004",
			"regionname": "МОСКОВСКАЯ ОБЛАСТЬ", "pr_sipst": 0, "okved2main": "62.01", "okved2mainname": "Разработка программного обеспечения",
		}}}},
		nil,
	)
	defer server.Close()
	client := &fnsCounterpartyClient{baseURL: server.URL, timeout: 3 * time.Second, limit: make(chan struct{}, 1)}
	result, err := client.lookup(context.Background(), "500100732259")
	if err != nil {
		t.Fatal(err)
	}
	if result.EntityType != "individual_entrepreneur" || result.SuggestedName != "ИП ИВАНОВ ИВАН ИВАНОВИЧ" || !result.Active {
		t.Fatalf("unexpected entrepreneur: %+v", result)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "подробную карточку") {
		t.Fatalf("expected search-card warning, got %v", result.Warnings)
	}
}

func TestFNSLookupPrefersActiveExactTaxID(t *testing.T) {
	rows := []map[string]any{
		{"namec": "СТАРАЯ ЗАПИСЬ", "inn": "7707083893", "sulst_ex": 0},
		{"namec": "ДЕЙСТВУЮЩАЯ ЗАПИСЬ", "inn": "7707083893", "sulst_ex": 10},
		{"namec": "ДРУГОЙ ИНН", "inn": "7727093893", "sulst_ex": 10},
	}
	server := newFNSTestServer(t, map[string]any{"ul": map[string]any{"data": rows}}, nil)
	defer server.Close()
	client := &fnsCounterpartyClient{baseURL: server.URL, timeout: 3 * time.Second, limit: make(chan struct{}, 1)}
	result, err := client.lookup(context.Background(), "7707083893")
	if err != nil {
		t.Fatal(err)
	}
	if result.SuggestedName != "ДЕЙСТВУЮЩАЯ ЗАПИСЬ" || !result.Active {
		t.Fatalf("active exact row was not selected: %+v", result)
	}
}

func TestFNSLookupReportsCaptchaRateAndNoResult(t *testing.T) {
	tests := []struct {
		name    string
		initial map[string]any
		search  map[string]any
		want    error
	}{
		{name: "captcha", initial: map[string]any{"id": "search-id", "captchaRequired": true}, want: errFNSCaptcha},
		{name: "rate", initial: map[string]any{"id": "search-id", "ERRORS": map[string]string{"pbRateLimit": "too many"}}, want: errFNSRate},
		{name: "not found", initial: map[string]any{"id": "search-id"}, search: map[string]any{"ul": map[string]any{"data": []any{}}}, want: errFNSNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				if r.Form.Get("method") == "get-response" {
					writeTestJSON(t, w, test.search)
					return
				}
				writeTestJSON(t, w, test.initial)
			}))
			defer server.Close()
			client := &fnsCounterpartyClient{baseURL: server.URL, timeout: 2 * time.Second, limit: make(chan struct{}, 1)}
			_, err := client.lookup(context.Background(), "7707083893")
			if !errors.Is(err, test.want) {
				t.Fatalf("lookup error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestFNSLookupRejectsUnexpectedUnknownTaxIDWithoutCallingFNS(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	client := &fnsCounterpartyClient{baseURL: server.URL, timeout: time.Second, limit: make(chan struct{}, 1)}
	if _, err := client.lookup(context.Background(), "1234567890"); err == nil {
		t.Fatal("expected invalid checksum error")
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid INN triggered %d upstream calls", calls.Load())
	}
}

func newFNSTestServer(t *testing.T, searchResult map[string]any, companyResult map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case "/search-proc.json":
			if r.Form.Get("method") == "get-response" {
				writeTestJSON(t, w, searchResult)
				return
			}
			writeTestJSON(t, w, map[string]any{"id": "search-id"})
		case "/company-proc.json":
			if companyResult == nil {
				t.Fatal("company endpoint should not be called without a token")
			}
			if r.Form.Get("method") == "get-request" {
				writeTestJSON(t, w, map[string]any{"id": "company-id", "token": "response-token"})
				return
			}
			writeTestJSON(t, w, companyResult)
		default:
			http.NotFound(w, r)
		}
	}))
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func TestSameOfficialFNSHost(t *testing.T) {
	if !sameOfficialFNSHost("pb.nalog.ru", "https://pb.nalog.ru") {
		t.Fatal("official host must be accepted")
	}
	if sameOfficialFNSHost("example.com", "https://pb.nalog.ru") {
		t.Fatal("foreign redirect must be rejected")
	}
	if _, err := url.Parse(defaultFNSBaseURL); err != nil {
		t.Fatal(err)
	}
}
