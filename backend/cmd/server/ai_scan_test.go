package main

import "testing"

func TestParseAIScanTextExtractsRequiredFields(t *testing.T) {
	text := `
Счет на оплату № 40 от 31 мая 2026 г.
Поставщик (Исполнитель): ООО "ТЕХНОЛОГИЯ-К", ИНН 4401143275, КПП 440101001
Покупатель (Заказчик): ООО "МЦ "МИРТ"", ИНН 4401050775, КПП 440101001
Итого: 16 500,00
В том числе НДС 22%: 2 975,41
Всего к оплате: 16 500,00
`
	result := parseAIScanText(text, []string{`ООО "ТЕХНОЛОГИЯ-К"`}, []string{`ООО "МЦ "МИРТ"`})
	if result.Counterparty != `ООО "ТЕХНОЛОГИЯ-К"` {
		t.Fatalf("unexpected counterparty: %q", result.Counterparty)
	}
	if result.LegalEntity != `ООО "МЦ "МИРТ"` {
		t.Fatalf("unexpected legal entity: %q", result.LegalEntity)
	}
	if result.DocumentNumber != "Счет на оплату № 40" {
		t.Fatalf("unexpected document: %q", result.DocumentNumber)
	}
	if result.DocumentDate != "2026-05-31" {
		t.Fatalf("unexpected date: %q", result.DocumentDate)
	}
	if result.Amount == nil || *result.Amount != 16500 {
		t.Fatalf("unexpected amount: %v", result.Amount)
	}
}

func TestParseAIScanTextSupportsNumericDateAndDoesNotUseVAT(t *testing.T) {
	text := `Счет №НЧ/07/0000558 от 01.07.2026
Поставщик: Общество с ограниченной ответственностью "НОВАТЭК-Кострома", ИНН 4401017834
Покупатель: Общество с ограниченной ответственностью "Медицинский Центр Мирт", ИНН 4401050775
Сумма без НДС 74 177,78
В т.ч. НДС 13 483,44
Всего к оплате 74 177,78`
	result := parseAIScanText(text, []string{`ООО "НОВАТЭК-Кострома"`}, []string{`ООО "Медицинский Центр Мирт"`})
	if result.DocumentDate != "2026-07-01" {
		t.Fatalf("unexpected date: %q", result.DocumentDate)
	}
	if result.Amount == nil || *result.Amount != 74177.78 {
		t.Fatalf("unexpected amount: %v", result.Amount)
	}
}

func TestParseAIScanTextUsesSupplierInsteadOfBankAccount(t *testing.T) {
	text := `
Поставщик: Общество с ограниченной ответственностью "НОВАТЭК-Кострома", ИНН 4401017834
Адрес: 156005, Костромская обл., г. Кострома
ИНН/КПП: 4401017834/7635150001
Расчетный счет: 40702810229000002761 в ЦЕНТРАЛЬНО-ЧЕРНОЗЕМНЫЙ БАНК ПАО СБЕРБАНК
Покупатель: Общество с ограниченной ответственностью "Медицинский Центр Мирт", ИНН 4401050775
Счет №НЧ/07/000558 от 01.07.2026
Всего к оплате 74 771,78
`
	result := parseAIScanText(text, []string{"Сбербанк", `ООО "НОВАТЭК-Кострома"`}, []string{`ООО "Медицинский Центр Мирт"`})
	if result.Counterparty != `ООО "НОВАТЭК-Кострома"` {
		t.Fatalf("expected supplier, got %q", result.Counterparty)
	}
}

func TestParseAIScanTextExtractsUnknownSupplierInsteadOfKnownBank(t *testing.T) {
	text := `
Поставщик: Общество с ограниченной ответственностью "НОВАТЭК-Кострома", ИНН 4401017834
Расчетный счет: 40702810229000002761 в ПАО СБЕРБАНК
Покупатель: ООО "МЦ МИРТ", ИНН 4401050775
Счет №НЧ/07/000558 от 01.07.2026
Всего к оплате 74 771,78
`
	result := parseAIScanText(text, []string{"Сбербанк"}, []string{`ООО "МЦ МИРТ"`})
	if result.Counterparty != `Общество с ограниченной ответственностью "НОВАТЭК-Кострома"` {
		t.Fatalf("expected extracted supplier, got %q", result.Counterparty)
	}
}

func TestParseAIScanDateRejectsImpossibleDate(t *testing.T) {
	if value := parseAIScanDate("31.02.2026"); value != "" {
		t.Fatalf("expected empty date, got %q", value)
	}
}

func TestParseAIScanTextHandlesBrokenPaymentWordAndIntegerAmount(t *testing.T) {
	text := "Счет на опл\nату №273 от 26 июня 2026г.\nИсполнитель: ИП Сечкин Евгений Павлович\nЗаказчик: ООО МЦ МИРТ\nИтого: 3000"
	result := parseAIScanText(text, []string{"ИП Сечкин Евгений Павлович"}, []string{"ООО МЦ МИРТ"})
	if result.DocumentNumber != "Счет на оплату № 273" || result.DocumentDate != "2026-06-26" {
		t.Fatalf("unexpected document: %q, %q", result.DocumentNumber, result.DocumentDate)
	}
	if result.Amount == nil || *result.Amount != 3000 {
		t.Fatalf("unexpected amount: %v", result.Amount)
	}
}
