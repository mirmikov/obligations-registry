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
Корреспондентский счет: 30101810600000000681, БИК 042007681
Куратор: Зубков Владимир Николаевич, телефон (4942) 39-52-19
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

func TestParseAIScanTextSupportsUniversalTransferDocument(t *testing.T) {
	text := `
Универсальный передаточный документ
Счет-фактура № 35538 от 31 июля 2026 г.
Продавец: ООО "ЦНФС" (2) Покупатель: Общество с ограниченной ответственностью "МЕДИЦИНСКИЙ ЦЕНТР "МИРТ""
Адрес: 109544, Москва
ИНН/КПП продавца: 9709078370/770901001
ИНН/КПП покупателя: 4401050775/440101001
Наименование товара (описание выполненных работ, оказанных услуг)
Всего к оплате (9) 81,15 X 17,85 99,00
`
	result := parseAIScanText(text, []string{`ООО "ЦНФС"`}, []string{`ООО "МЦ "Мирт"`})
	if result.Counterparty != `ООО "ЦНФС"` {
		t.Fatalf("unexpected UPD seller: %q", result.Counterparty)
	}
	if result.LegalEntity != `ООО "МЦ "Мирт"` {
		t.Fatalf("unexpected UPD buyer: %q", result.LegalEntity)
	}
	if result.DocumentNumber != "УПД № 35538" || result.DocumentDate != "2026-07-31" {
		t.Fatalf("unexpected UPD document: %q, %q", result.DocumentNumber, result.DocumentDate)
	}
	if result.Amount == nil || *result.Amount != 99 {
		t.Fatalf("unexpected UPD amount: %v", result.Amount)
	}
	if !usableAIScanTextLayer(text) {
		t.Fatal("expected UPD text layer to be preferred over OCR")
	}
}

func TestParseAIScanTextSupportsColumnOrderedUPDBuyer(t *testing.T) {
	text := `
Универсальный         Счет-фактура № 35538 от 31 июля 2026 г.
передаточный документ
Общество с ограниченной ответственностью "МЕДИЦИНСКИЙ
Продавец: ООО "ЦНФС" (2) Покупатель: ЦЕНТР "МИРТ"" (6)
Адрес: 109544, Москва Адрес: 156001, Кострома
ИНН/КПП продавца: 9709078370/770901001 ИНН/КПП покупателя: 4401050775/440101001
Всего к оплате (9) 81,15 Х 17,85 99,00
`
	result := parseAIScanText(text, []string{`ООО "ЦНФС"`}, []string{`ООО "МЦ "Мирт"`})
	if result.LegalEntity != `ООО "МЦ "Мирт"` {
		t.Fatalf("unexpected column-ordered UPD buyer: %q", result.LegalEntity)
	}
}

func TestParseAIScanTextSupportsRecipientPayerAndOfferInvoice(t *testing.T) {
	text := `
ИНН 7704217370
КПП 997750001
Сч.№ 40702810200000598886
Получатель                                   БИК        044525068
Интернет Решения, ООО
Банк получателя                              Сч.№       30101810645374525068
ООО "ОЗОН Банк"
Назначение платежа Оплата по заказу 0259379144-0002 от 22.07.2026
Счет-Оферта № 0259379144-0002 от 22.07.2026
Плательщик: ООО "МЦ "МИРТ"", ИНН 4401050775
Итого: 12 028,00
Всего к оплате с учетом НДС: 12 028,00
Сумма к оплате: 12 028,00
`
	result := parseAIScanText(text, []string{"Интернет Решения, ООО", `ООО "ОЗОН Банк"`}, []string{`ООО "МЦ "Мирт"`})
	if result.Counterparty != "Интернет Решения, ООО" {
		t.Fatalf("unexpected recipient: %q", result.Counterparty)
	}
	if result.LegalEntity != `ООО "МЦ "Мирт"` {
		t.Fatalf("unexpected payer: %q", result.LegalEntity)
	}
	if result.DocumentNumber != "Счет-оферта № 0259379144-0002" || result.DocumentDate != "2026-07-22" {
		t.Fatalf("unexpected offer invoice: %q, %q", result.DocumentNumber, result.DocumentDate)
	}
	if result.Amount == nil || *result.Amount != 12028 {
		t.Fatalf("unexpected amount: %v", result.Amount)
	}
	if len(result.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", result.Warnings)
	}
}

func TestAIScanTextLayerRejectsSparseGarbage(t *testing.T) {
	if usableAIScanTextLayer("12345 ---") {
		t.Fatal("sparse text layer must fall back to OCR")
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

func TestParseAIScanTextRecoversShortSupplierFromReorderedPaymentTable(t *testing.T) {
	text := `
ЦЕНТРАЛЬНО-ЧЕРНОЗЕМНЫЙ БАНК ПАО СБЕРБАНК . |БИК 042007681
ИНН 4401187917 КПП 440101001 Сч. № 40702810229000005865
ООО "МП" Вид оп. 01 |Срок плат.
Наз. пл. Очер. плат. 5
[Получатель! Код Рез. поле
Счет на оплату № ЦБ-881 от 10 августа 2026 г.
Поставщик — помещение 12
Покупатель: ООО МЦ Мирт, ИНН 4401050775, КПП 440101001
000 "МП", ИНН 4401187917, КПП 440101001, 156026, Костромская обл.
Итого с НДС: 17 986,25
`
	result := parseAIScanText(text, []string{`ООО "МП"`, "ПАО СБЕРБАНК"}, []string{"ООО МЦ Мирт"})
	if result.Counterparty != `ООО "МП"` {
		t.Fatalf("expected short supplier, got %q", result.Counterparty)
	}
	if result.DocumentNumber != "Счет на оплату № ЦБ-881" || result.DocumentDate != "2026-08-10" {
		t.Fatalf("unexpected document: %q, %q", result.DocumentNumber, result.DocumentDate)
	}
}

func TestParseAIScanTextSupportsSpacedAlphanumericNumberAndRussianMonth(t *testing.T) {
	text := `
Счет на оплату № ВХ02 - 097502
от 31 июля 2026 г.
Поставщик: ООО "Поставщик", ИНН 7700000000
Покупатель: ООО МЦ МИРТ, ИНН 4401050775
Всего к оплате: 1 000,00
`
	result := parseAIScanText(text, []string{`ООО "Поставщик"`}, []string{"ООО МЦ МИРТ"})
	if result.DocumentNumber != "Счет на оплату № ВХ02-097502" {
		t.Fatalf("unexpected document number: %q", result.DocumentNumber)
	}
	if result.DocumentDate != "2026-07-31" {
		t.Fatalf("unexpected document date: %q", result.DocumentDate)
	}
}

func TestParseAIScanDateSupportsNumericFieldsSeparatedBySpaces(t *testing.T) {
	if value := parseAIScanDate("31 07 2026"); value != "2026-07-31" {
		t.Fatalf("unexpected spaced numeric date: %q", value)
	}
}

func TestExtractAIScanRecipientKeepsBareLabelLayout(t *testing.T) {
	text := "Получатель\nИнтернет Решения, ООО\nБанк получателя\nООО ОЗОН Банк"
	if value := extractAIScanRecipient(text); value != "Интернет Решения, ООО" {
		t.Fatalf("unexpected recipient after bare label: %q", value)
	}
}
