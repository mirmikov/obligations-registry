package main

import (
	"math"
	"testing"
	"time"
)

func learningAmount(value float64) *float64 { return &value }

func TestAIScanLearningTemplateIgnoresTransactionNumbers(t *testing.T) {
	left := aiScanLearningTemplateTokens("Счет-фактура № ЯРС01966412 от 20.08.2026 Продавец ООО ПУЛЬС ЯРОСЛАВЛЬ Всего к оплате 11 865,39")
	right := aiScanLearningTemplateTokens("Счет-фактура № ЯРС01977110 от 26.08.2026 Продавец ООО ПУЛЬС ЯРОСЛАВЛЬ Всего к оплате 24 100,70")
	if similarity := aiScanLearningSimilarity(left, right); similarity < 0.90 {
		t.Fatalf("similar invoice templates must match, got %.3f", similarity)
	}
}

func TestAIScanLearningAmountExtractsNewDocumentValue(t *testing.T) {
	trainingText := "Счет-фактура № ЯРС01966412 от 20.08.2026\nПродавец ООО ПУЛЬС ЯРОСЛАВЛЬ\nВсего к оплате 11 865,39"
	futureText := "Счет-фактура № ЯРС01977110 от 26.08.2026\nПродавец ООО ПУЛЬС ЯРОСЛАВЛЬ\nВсего к оплате 24 100,70"
	detected := aiScanSuggestion{Page: 1, Amount: learningAmount(118.65), DocumentDate: "2026-08-20"}
	items := []aiScanCommitItem{{Page: 1, Values: obligationInput{Amount: learningAmount(11865.39), DocumentDate: "2026-08-20"}}}
	documents := []aiScanLearningDocument{{Page: 1, Text: trainingText, TemplateTokens: aiScanLearningTemplateTokens(trainingText)}}
	rules := aiScanLearningRulesForCommit(map[int]aiScanSuggestion{1: detected}, items, documents, time.Date(2026, 8, 26, 16, 0, 0, 0, time.UTC))
	if len(rules) != 1 || rules[0].Field != "amount" || rules[0].StaticValue != "" {
		t.Fatalf("expected one dynamic amount rule, got %#v", rules)
	}
	result := applyAIScanLearningRules(aiScanSuggestion{Amount: learningAmount(241.00), DocumentDate: "2026-08-26", Confidence: map[string]string{"amount": "low"}}, futureText, rules)
	if result.Amount == nil || math.Abs(*result.Amount-24100.70) > 0.005 {
		t.Fatalf("learning copied or extracted the wrong amount: %#v", result.Amount)
	}
	if len(result.LearnedFields) != 1 || result.LearnedFields[0] != "amount" {
		t.Fatalf("learned field is not exposed: %#v", result.LearnedFields)
	}
}

func TestAIScanLearningStaticCorrectionDoesNotOverrideHighConfidenceOnce(t *testing.T) {
	text := "Универсальный передаточный документ Продавец ООО ПУЛЬС ЯРОСЛАВЛЬ Покупатель ООО МЕДИЦИНСКИЙ ЦЕНТР МИРТ"
	rule := aiScanLearningRule{Version: aiScanLearningVersion, Field: "counterparty", StaticValue: "ООО ПУЛЬС ЯРОСЛАВЛЬ", TemplateTokens: aiScanLearningTemplateTokens(text), Support: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	high := aiScanSuggestion{Counterparty: "ООО ДРУГОЙ ПОСТАВЩИК", Confidence: map[string]string{"counterparty": "high"}}
	result := applyAIScanLearningRules(high, text, []aiScanLearningRule{rule})
	if result.Counterparty != high.Counterparty {
		t.Fatalf("single correction must not override high-confidence recognition: %q", result.Counterparty)
	}
	low := aiScanSuggestion{Counterparty: "ПУЛЬС БАНК", Confidence: map[string]string{"counterparty": "low"}}
	result = applyAIScanLearningRules(low, text, []aiScanLearningRule{rule})
	if result.Counterparty != "ООО ПУЛЬС ЯРОСЛАВЛЬ" {
		t.Fatalf("confirmed template correction did not replace low recognition: %q", result.Counterparty)
	}
}

func TestAIScanLearningDoesNotCreateRulesWithoutCorrections(t *testing.T) {
	amount := 11865.39
	detected := aiScanSuggestion{Page: 1, Counterparty: "ООО ПУЛЬС", LegalEntity: "ООО МЦ МИРТ", DocumentNumber: "ЯРС01966412", DocumentDate: "2026-08-20", Amount: &amount}
	item := aiScanCommitItem{Page: 1, Values: obligationInput{Counterparty: detected.Counterparty, LegalEntity: detected.LegalEntity, DocumentNumber: detected.DocumentNumber, DocumentDate: detected.DocumentDate, Amount: &amount}}
	text := "Счет-фактура № ЯРС01966412 от 20.08.2026 Всего к оплате 11 865,39"
	rules := aiScanLearningRulesForCommit(map[int]aiScanSuggestion{1: detected}, []aiScanCommitItem{item}, []aiScanLearningDocument{{Page: 1, Text: text, TemplateTokens: aiScanLearningTemplateTokens(text)}}, time.Now())
	if len(rules) != 0 {
		t.Fatalf("unchanged result must not teach anything: %#v", rules)
	}
}

func TestGroupAIScanDocumentsCalculatesCrossPageDeferment(t *testing.T) {
	tests := []struct {
		name  string
		terms string
		want  int
	}{
		{name: "explicit payment date", terms: "Дата оплаты: 11.09.26", want: 22},
		{name: "payment deadline", terms: "Срок оплаты - 03.09.2026 от 20.08.2026", want: 14},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			first := aiScanSuggestion{DocumentNumber: "Счет-фактура № ЯРС01966412", DocumentDate: "2026-08-20", Confidence: map[string]string{"document_number": "high", "document_date": "high"}}
			second := aiScanSuggestion{Amount: learningAmount(11865.39), Confidence: map[string]string{"amount": "high"}}
			groups := groupAIScanDocumentSuggestions([]aiScanSuggestion{first, second}, []string{"Счет-фактура № ЯРС01966412 от 20.08.2026", "Продолжение таблицы\nВсего к оплате 11 865,39\n" + test.terms})
			if len(groups) != 1 || groups[0].DefermentDays == nil || *groups[0].DefermentDays != test.want {
				t.Fatalf("cross-page deferment mismatch: %#v", groups)
			}
		})
	}
}

func TestAIScanLearningRuleNeedsSimilarTemplate(t *testing.T) {
	trained := "Счет-фактура Продавец ООО ПУЛЬС ЯРОСЛАВЛЬ Покупатель МИРТ Всего к оплате"
	rule := aiScanLearningRule{Version: aiScanLearningVersion, Field: "counterparty", StaticValue: "ООО ПУЛЬС ЯРОСЛАВЛЬ", TemplateTokens: aiScanLearningTemplateTokens(trained), Support: 10, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	unrelated := "Кассовый чек АЗС топливо литры цена карта терминал"
	result := applyAIScanLearningRules(aiScanSuggestion{Counterparty: "АЗС", Confidence: map[string]string{"counterparty": "low"}}, unrelated, []aiScanLearningRule{rule})
	if result.Counterparty != "АЗС" {
		t.Fatalf("rule leaked to unrelated document: %q", result.Counterparty)
	}
}
