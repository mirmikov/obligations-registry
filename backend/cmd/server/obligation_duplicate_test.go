package main

import (
	"strings"
	"testing"
)

func floatPointer(value float64) *float64 { return &value }

func TestNormalizedDocumentNumberHandlesInvoiceFormattingVariants(t *testing.T) {
	variants := []string{
		"Счёт на оплату № АВ-000123/26 от 10.08.2026",
		"счет № AB 123-26",
		"№ав/00123/026",
	}
	want := normalizedDocumentNumber(variants[0])
	for _, value := range variants[1:] {
		if got := normalizedDocumentNumber(value); got != want {
			t.Fatalf("normalizedDocumentNumber(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestNormalizedPartyNameHandlesLegalFormAndPunctuation(t *testing.T) {
	left := normalizedPartyName(`Общество с ограниченной ответственностью "НОВАТЭК-Кострома"`)
	right := normalizedPartyName(`ООО «Новатэк Кострома»`)
	if left == "" || left != right {
		t.Fatalf("party identities differ: %q != %q", left, right)
	}
}

func TestEvaluateDuplicateUsesCounterpartyTaxIDAcrossDifferentNames(t *testing.T) {
	input := obligationInput{Counterparty: "Новое название поставщика", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 55", DocumentDate: "2026-08-10", Amount: floatPointer(12500)}
	candidate := duplicateCandidate{id: 42, counterparty: "Старое название", legalEntity: `ООО "МЦ МИРТ"`, documentNumber: "55", documentDate: "2026-08-10", amount: floatPointer(12500)}
	taxIDs := map[string]string{normalizedPartyName(input.Counterparty): "4401000000", normalizedPartyName(candidate.counterparty): "4401000000"}
	match, ok := evaluateDuplicate(input, "", candidate, taxIDs)
	if !ok || match.Confidence != "exact" {
		t.Fatalf("expected exact duplicate, got ok=%v match=%#v", ok, match)
	}
	if !strings.Contains(strings.Join(match.Reasons, " "), "ИНН") {
		t.Fatalf("expected tax ID reason, got %v", match.Reasons)
	}
}

func TestEvaluateDuplicateFlagsSameInvoiceWhenAmountWasChanged(t *testing.T) {
	input := obligationInput{Counterparty: "ООО Альфа", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 007", DocumentDate: "2026-08-10", Amount: floatPointer(100)}
	candidate := duplicateCandidate{id: 7, counterparty: "Альфа", legalEntity: "МЦ МИРТ", documentNumber: "7", documentDate: "2026-08-10", amount: floatPointer(120)}
	match, ok := evaluateDuplicate(input, "", candidate, nil)
	if !ok || match.Confidence != "exact" {
		t.Fatalf("expected exact duplicate despite amount discrepancy, got ok=%v match=%#v", ok, match)
	}
	if !strings.Contains(strings.Join(match.Reasons, " "), "сумма отличается") {
		t.Fatalf("missing amount discrepancy warning: %v", match.Reasons)
	}
}

func TestEvaluateDuplicateFlagsNearbyDateOCRVariation(t *testing.T) {
	input := obligationInput{Counterparty: "ООО Альфа", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 25", DocumentDate: "2026-08-10", Amount: floatPointer(999.99)}
	candidate := duplicateCandidate{id: 9, counterparty: "Альфа", legalEntity: "МЦ МИРТ", documentNumber: "25", documentDate: "2026-08-12", amount: floatPointer(999.99)}
	match, ok := evaluateDuplicate(input, "", candidate, nil)
	if !ok || match.Confidence != "high" {
		t.Fatalf("expected high-probability duplicate, got ok=%v match=%#v", ok, match)
	}
	if !strings.Contains(strings.Join(match.Reasons, " "), "1–3 дня") {
		t.Fatalf("missing nearby-date explanation: %v", match.Reasons)
	}
}

func TestEvaluateDuplicateDoesNotFlagDifferentInvoice(t *testing.T) {
	input := obligationInput{Counterparty: "ООО Альфа", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 25", DocumentDate: "2026-08-10", Amount: floatPointer(100)}
	candidate := duplicateCandidate{id: 10, counterparty: "ООО Бета", legalEntity: "ООО Другая компания", documentNumber: "Счет № 900", documentDate: "2026-07-01", amount: floatPointer(100)}
	if match, ok := evaluateDuplicate(input, "", candidate, nil); ok {
		t.Fatalf("different invoice flagged as duplicate: %#v", match)
	}
}

func TestEvaluateDuplicateIgnoresInstallmentsInSameSplitGroup(t *testing.T) {
	input := obligationInput{Counterparty: "ООО Альфа", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 25", DocumentDate: "2026-08-10", Amount: floatPointer(100)}
	candidate := duplicateCandidate{id: 11, counterparty: "ООО Альфа", legalEntity: "ООО МЦ МИРТ", documentNumber: "25", documentDate: "2026-08-10", amount: floatPointer(100), splitGroupID: "schedule-1"}
	if match, ok := evaluateDuplicate(input, "schedule-1", candidate, nil); ok {
		t.Fatalf("same payment schedule flagged as duplicate: %#v", match)
	}
}

func TestDuplicateIdentityChangedIgnoresUnrelatedFields(t *testing.T) {
	before := obligationInput{Counterparty: "ООО Альфа", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "Счет № 25", DocumentDate: "2026-08-10", Amount: floatPointer(100), Comment: "до"}
	after := before
	after.Comment = "после"
	if duplicateIdentityChanged(before, after) {
		t.Fatal("comment-only edit must not re-run duplicate confirmation")
	}
	after.Amount = floatPointer(101)
	if !duplicateIdentityChanged(before, after) {
		t.Fatal("amount edit must re-run duplicate confirmation")
	}
}
