package main

import "testing"

func TestApplyAIScanDefaultsSetsRegisteredStatus(t *testing.T) {
	values := obligationInput{}
	applyAIScanDefaults(&values)
	if values.Status != "Зарегистрирован" {
		t.Fatalf("expected registered status, got %q", values.Status)
	}
}

func TestApplyAIScanDefaultsPreservesExplicitStatus(t *testing.T) {
	values := obligationInput{Status: "К оплате"}
	applyAIScanDefaults(&values)
	if values.Status != "К оплате" {
		t.Fatalf("expected explicit status to be preserved, got %q", values.Status)
	}
}
