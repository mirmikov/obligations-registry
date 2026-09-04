package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractAIScanDefermentFromCalendarDays(t *testing.T) {
	days, terms, confidence := extractAIScanDeferment("Условия оплаты: отсрочка платежа 30 календарных дней с даты счета", "2026-08-10")
	if days == nil || *days != 30 || confidence != "high" || !strings.Contains(terms, "30 календарных дней") {
		t.Fatalf("unexpected deferment: days=%v terms=%q confidence=%q", days, terms, confidence)
	}
}

func TestExtractAIScanDefermentFromExplicitPaymentDaysCount(t *testing.T) {
	days, terms, confidence := extractAIScanDeferment("Количество дней для оплаты 30", "2026-08-31")
	if days == nil || *days != 30 || terms != "Количество дней для оплаты 30" || confidence != "high" {
		t.Fatalf("unexpected Megafon payment days: days=%v terms=%q confidence=%q", days, terms, confidence)
	}
}
func TestExtractAIScanDefermentPrefersExactLaterCondition(t *testing.T) {
	days, terms, confidence := extractAIScanDeferment("Условия оплаты: согласно договору\nОтсрочка платежа 25 календарных дней", "2026-08-10")
	if days == nil || *days != 25 || confidence != "high" || !strings.Contains(terms, "25 календарных") {
		t.Fatalf("exact condition did not override generic terms: days=%v terms=%q confidence=%q", days, terms, confidence)
	}
}

func TestExtractAIScanDefermentFromDueDate(t *testing.T) {
	days, terms, confidence := extractAIScanDeferment("Оплатить не позднее 25.08.2026", "2026-08-10")
	if days == nil || *days != 15 || confidence != "high" || terms == "" {
		t.Fatalf("unexpected due-date deferment: days=%v terms=%q confidence=%q", days, terms, confidence)
	}
}

func TestExtractAIScanDefermentDoesNotConvertWorkingDaysToCalendarDays(t *testing.T) {
	days, terms, confidence := extractAIScanDeferment("Оплата в течение 10 рабочих дней после поставки", "2026-08-10")
	if days != nil || terms == "" || confidence != "low" {
		t.Fatalf("working days must remain for manual review: days=%v terms=%q confidence=%q", days, terms, confidence)
	}
}

func TestParseAIScanTextReturnsDefermentAndPaymentTerms(t *testing.T) {
	result := parseAIScanText(`
Счет № 51 от 10.08.2026
Поставщик: ООО "Поставщик"
Покупатель: ООО "МЦ МИРТ"
Всего к оплате: 100 000,00
Условия оплаты: отсрочка 45 календарных дней
`, []string{`ООО "Поставщик"`}, []string{`ООО "МЦ МИРТ"`})
	if result.DefermentDays == nil || *result.DefermentDays != 45 || result.PaymentTerms == "" {
		t.Fatalf("deferment was not returned by parser: %#v", result)
	}
}

func TestGroupAIScanDocumentSuggestionsCombinesContinuationPages(t *testing.T) {
	firstAmount, finalAmount := 1200.0, 3500.0
	first := aiScanSuggestion{DocumentNumber: "Счет № 17", DocumentDate: "2026-08-10", Amount: &firstAmount, Confidence: map[string]string{"document_number": "high", "document_date": "high", "amount": "high"}}
	continuation := aiScanSuggestion{Amount: &finalAmount, DefermentDays: intPointer(20), PaymentTerms: "Отсрочка 20 календарных дней", Confidence: map[string]string{"amount": "high", "deferment_days": "high"}}
	groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, continuation}, []string{"Счет № 17 от 10.08.2026", "Продолжение таблицы\nВсего к оплате 3 500,00"})
	if len(groups) != 1 || groups[0].Page != 1 || len(groups[0].Pages) != 2 || groups[0].Pages[1] != 2 {
		t.Fatalf("continuation pages were not grouped: %#v", groups)
	}
	if groups[0].Amount == nil || *groups[0].Amount != 3500 || groups[0].DefermentDays == nil || *groups[0].DefermentDays != 20 {
		t.Fatalf("group did not use continuation fields: %#v", groups[0])
	}
}

func TestGroupAIScanDocumentSuggestionsKeepsDifferentInvoicesSeparate(t *testing.T) {
	first := aiScanSuggestion{DocumentNumber: "Счет № 17", DocumentDate: "2026-08-10", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	second := aiScanSuggestion{DocumentNumber: "Счет № 18", DocumentDate: "2026-08-10", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, second}, []string{"Счет № 17 от 10.08.2026", "Счет № 18 от 10.08.2026"})
	if len(groups) != 2 || groups[0].Page != 1 || groups[1].Page != 2 {
		t.Fatalf("different invoices were merged: %#v", groups)
	}
}

func TestGroupAIScanMegafonBillingPacketAsOneObligation(t *testing.T) {
	amount := 377.0
	perPage := []aiScanSuggestion{
		{DocumentNumber: "Счёт № 108-1", DocumentDate: "2026-08-31", Amount: &amount, Confidence: map[string]string{"document_number": "high", "document_date": "high", "amount": "high"}},
		{Confidence: map[string]string{}},
		{Counterparty: "МегаФон", CounterpartyTaxID: "7812014560", DocumentNumber: "Счёт-фактура № 20738261675/100", DocumentDate: "2026-08-31", Amount: &amount, Confidence: map[string]string{"counterparty": "high", "document_number": "high", "document_date": "high", "amount": "high"}},
		{Counterparty: "МегаФон", CounterpartyTaxID: "7812014560", DocumentNumber: "Счёт на оплату № 170085961036", DocumentDate: "2026-08-31", Amount: &amount, Confidence: map[string]string{"counterparty": "high", "document_number": "high", "document_date": "high", "amount": "high"}},
	}
	pageTexts := []string{
		"МегаФон ПроБизнес\nСчёт № 108-1 от 31.08.2026\nза расчётный период: 01.08.2026 - 31.08.2026\nОператор: ПАО МегаФон\nАбонент: ООО МИРТ-МРТ\nЛицевой счёт: 170085961036\nКоличество дней для оплаты 30",
		"Подробная информация\nСчёт и единый лицевой счёт: 108-1 170085961036",
		"МегаФон\nСчёт-фактура № 20738261675/100 от 31.08.2026\nИтого 377,00",
		"Получатель: ПАО МегаФон\nЛицевой счёт 170085961036\nСчёт на оплату № 170085961036 от 31.08.2026",
	}
	groups := groupAIScanDocumentSuggestions(perPage, pageTexts)
	if len(groups) != 1 {
		t.Fatalf("Megafon packet created %d obligations: %#v", len(groups), groups)
	}
	result := groups[0]
	if result.DocumentNumber != "Счёт № 108-1" || result.DocumentDate != "2026-08-31" || result.Counterparty != "МегаФон" || result.CounterpartyTaxID != "7812014560" || result.DefermentDays == nil || *result.DefermentDays != 30 {
		t.Fatalf("unexpected grouped Megafon bill: %#v", result)
	}
	if len(result.Pages) != 4 || result.Pages[0] != 1 || result.Pages[3] != 4 {
		t.Fatalf("unexpected grouped pages: %v", result.Pages)
	}
}

func TestGroupAIScanMegafonStartsNewPacketAtNextBillingCover(t *testing.T) {
	first := aiScanSuggestion{DocumentNumber: "Счёт № 108-1", DocumentDate: "2026-08-31", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	second := aiScanSuggestion{DocumentNumber: "Счёт № 109-1", DocumentDate: "2026-09-30", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	texts := []string{
		"МегаФон\nСчёт № 108-1 от 31.08.2026\nза расчётный период\nОператор\nАбонент\nЛицевой счёт: 170085961036",
		"МегаФон\nСчёт № 109-1 от 30.09.2026\nза расчётный период\nОператор\nАбонент\nЛицевой счёт: 170085961036",
	}
	groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, second}, texts)
	if len(groups) != 2 {
		t.Fatalf("two Megafon covers must stay separate: %#v", groups)
	}
}

func TestGroupAIScanDocumentSuggestionsPreservesOperationalWarning(t *testing.T) {
	first := aiScanSuggestion{DocumentNumber: "Счет № 17", Confidence: map[string]string{"document_number": "high"}, Warnings: []string{"Страница распознана не полностью — проверьте значения вручную"}}
	continuation := aiScanSuggestion{Confidence: map[string]string{}, Warnings: []string{"Не распознано поле: сумма"}}
	groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, continuation}, []string{"Счет № 17", "Продолжение"})
	if len(groups) != 1 || !containsAIScanWarning(groups[0].Warnings, "Страница распознана не полностью — проверьте значения вручную") {
		t.Fatalf("operational warning was lost: %#v", groups)
	}
}

func containsAIScanWarning(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestGroupAIScanDocumentSuggestionsCombinesRepeatedHeader(t *testing.T) {
	first := aiScanSuggestion{DocumentNumber: "Счет № 17", DocumentDate: "2026-08-10", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	second := aiScanSuggestion{DocumentNumber: "Счет № 17", DocumentDate: "2026-08-10", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
	groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, second}, []string{"Счет № 17 от 10.08.2026", "Счет № 17 от 10.08.2026\nПродолжение"})
	if len(groups) != 1 || len(groups[0].Pages) != 2 {
		t.Fatalf("repeated header of the same invoice created a duplicate item: %#v", groups)
	}
}

func TestBuildAIScanImagePDFKeepsEveryPage(t *testing.T) {
	directory := t.TempDir()
	paths := make([]string, 0, 2)
	for index := 0; index < 2; index++ {
		path := filepath.Join(directory, string(rune('a'+index))+".png")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		imageValue := image.NewRGBA(image.Rect(0, 0, 24, 36))
		for y := 0; y < 36; y++ {
			for x := 0; x < 24; x++ {
				imageValue.Set(x, y, color.RGBA{R: uint8(40 + index*80), G: 100, B: 140, A: 255})
			}
		}
		if err = png.Encode(file, imageValue); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		_ = file.Close()
		paths = append(paths, path)
	}
	pdf, err := buildAIScanImagePDF(paths)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.4")) || !bytes.Contains(pdf, []byte("/Count 2")) {
		t.Fatalf("invalid multi-page PDF: %q", pdf[:min(len(pdf), 40)])
	}
}
