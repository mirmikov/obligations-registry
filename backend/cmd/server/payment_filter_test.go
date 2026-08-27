package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildFiltersSupportsPartialDocumentNumber(t *testing.T) {
	r := httptest.NewRequest("GET", "/?document_number=%D0%A1%D0%A7-42", nil)
	where, args := buildFilters(r, 1)
	if !strings.Contains(where, "document_number ILIKE '%'||$1||'%'") {
		t.Fatalf("filter SQL %q does not search document number", where)
	}
	if len(args) != 1 || args[0] != "СЧ-42" {
		t.Fatalf("document number args = %#v, want [СЧ-42]", args)
	}
}
