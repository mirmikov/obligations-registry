package main

import "testing"

func TestNormalizeCounterpartyTaxID(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "optional", input: "  ", want: ""},
		{name: "legal entity", input: "77-03 727595", want: "7703727595"},
		{name: "individual", input: "500100732259", want: "500100732259"},
		{name: "wrong length", input: "123", wantErr: true},
		{name: "letters", input: "770372759A", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeCounterpartyTaxID(test.input)
			if test.wantErr {
				if err == nil {
					t.Fatalf("normalizeCounterpartyTaxID(%q) returned no error", test.input)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("normalizeCounterpartyTaxID(%q) = %q, %v; want %q", test.input, got, err, test.want)
			}
		})
	}
}
