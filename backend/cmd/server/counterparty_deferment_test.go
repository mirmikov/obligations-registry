package main

import "testing"

func TestCounterpartyDefermentReferenceRoundTrip(t *testing.T) {
	encoded := encodeCounterpartyDefermentReference(42, 30)
	result, ok := decodeCounterpartyDefermentReference(encoded)
	if !ok || result.CounterpartyID != 42 || result.DefermentDays != 30 {
		t.Fatalf("unexpected mapping: %#v, ok=%v", result, ok)
	}
}

func TestCounterpartyDefermentReferenceAllowsZeroAndRejectsInvalidValues(t *testing.T) {
	if result, ok := decodeCounterpartyDefermentReference(encodeCounterpartyDefermentReference(7, 0)); !ok || result.DefermentDays != 0 {
		t.Fatalf("zero-day deferment must be valid: %#v, ok=%v", result, ok)
	}
	for _, value := range []string{
		`{"counterparty_id":0,"deferment_days":10}`,
		`{"counterparty_id":7,"deferment_days":-1}`,
		`{"counterparty_id":7,"deferment_days":36501}`,
		`not-json`,
	} {
		if _, ok := decodeCounterpartyDefermentReference(value); ok {
			t.Fatalf("invalid mapping accepted: %s", value)
		}
	}
}
