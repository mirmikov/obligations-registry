package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func TestObligationNormalizeCalculatesPlannedDate(t *testing.T) {
	days := 10
	input := obligationInput{DocumentDate: "2026-07-01", DefermentDays: &days, PlannedPaymentDate: "2026-12-31"}
	input.normalize()
	if input.PlannedPaymentDate != "2026-07-11" {
		t.Fatalf("planned date = %q, want 2026-07-11", input.PlannedPaymentDate)
	}
	if input.EntryDate == "" {
		t.Fatal("entry date must be populated")
	}
}

func TestPresenceExpiresStaleSessions(t *testing.T) {
	hub := newPresenceHub()
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	hub.update(authUser{ID: 1, Name: "Администратор", Role: "admin"}, presenceInput{SessionID: "session-admin", Page: "registry", Mode: "edit", RecordID: 42, Field: "amount"}, now)
	hub.update(authUser{ID: 2, Name: "Редактор", Role: "editor"}, presenceInput{SessionID: "session-editor", Page: "registry"}, now.Add(-presenceTTL-time.Second))
	items := hub.list(now)
	if len(items) != 1 || items[0].SessionID != "session-admin" {
		t.Fatalf("active presence = %#v", items)
	}
}

func TestPresenceCanOnlyBeRemovedByItsUser(t *testing.T) {
	hub := newPresenceHub()
	now := time.Now()
	hub.update(authUser{ID: 7, Name: "Редактор"}, presenceInput{SessionID: "session-123"}, now)
	hub.remove("session-123", 8)
	if len(hub.list(now)) != 1 {
		t.Fatal("another user removed the session")
	}
	hub.remove("session-123", 7)
	if len(hub.list(now)) != 0 {
		t.Fatal("session owner could not remove the session")
	}
}

func TestBuildFiltersUsesBoundParameters(t *testing.T) {
	r := httptest.NewRequest("GET", "/?status=%D0%9A+%D0%BE%D0%BF%D0%BB%D0%B0%D1%82%D0%B5&q=%D0%94%D0%B5%D0%BB%D1%8C%D1%82%D0%B0&entry_date=2026-07-18&overdue=true", nil)
	where, args := buildFilters(r, 1)
	if len(args) != 3 {
		t.Fatalf("got %d args, want 3", len(args))
	}
	for _, expected := range []string{"status=$1", "$2", "entry_date = $3::date", "planned_payment_date<CURRENT_DATE"} {
		if !strings.Contains(where, expected) {
			t.Fatalf("filter SQL %q does not contain %q", where, expected)
		}
	}
}

func TestBuildFiltersUsesDocumentDateRange(t *testing.T) {
	r := httptest.NewRequest("GET", "/?document_from=2026-07-01&document_to=2026-07-31", nil)
	where, args := buildFilters(r, 1)
	if len(args) != 2 || args[0] != "2026-07-01" || args[1] != "2026-07-31" {
		t.Fatalf("document range args = %#v, want [2026-07-01 2026-07-31]", args)
	}
	for _, expected := range []string{"document_date >= $1::date", "document_date <= $2::date"} {
		if !strings.Contains(where, expected) {
			t.Fatalf("filter SQL %q does not contain %q", where, expected)
		}
	}
}

func TestBuildFiltersSupportsMultipleCounterparties(t *testing.T) {
	r := httptest.NewRequest("GET", "/?counterparty=Альфа&counterparty=Бета&counterparty=Альфа", nil)
	where, args := buildFilters(r, 1)
	if !strings.Contains(where, "counterparty=ANY($1::text[])") {
		t.Fatalf("filter SQL %q does not use a text array", where)
	}
	values, ok := args[0].([]string)
	if !ok || len(values) != 2 || values[0] != "Альфа" || values[1] != "Бета" {
		t.Fatalf("counterparty args = %#v, want [Альфа Бета]", args[0])
	}
}

func TestNormalizeWorkspaceStateRejectsUnknownPage(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "users<script>", SidebarCollapsed: true})
	if value.Page != "dashboard" || !value.SidebarCollapsed {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestNormalizeWorkspaceStateAcceptsCreditsLeasingReport(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "credits-leasing"})
	if value.Page != "credits-leasing" {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestNormalizeWorkspaceStateAcceptsChat(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "chat"})
	if value.Page != "chat" {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestDatabaseMigrationsCanBeDisabledForProductionCodeDeploy(t *testing.T) {
	t.Setenv("RUN_DATABASE_MIGRATIONS", "false")
	if databaseMigrationsEnabled() {
		t.Fatal("database migrations must be disabled")
	}
	t.Setenv("RUN_DATABASE_MIGRATIONS", "true")
	if !databaseMigrationsEnabled() {
		t.Fatal("database migrations must be enabled")
	}
}

func TestUndoHistoryLimitIsFiveHundredPerUser(t *testing.T) {
	if maxUndoOperationsPerUser != 500 {
		t.Fatalf("undo history limit = %d, want 500", maxUndoOperationsPerUser)
	}
}

func TestUndoSnapshotsCompareJSONByValue(t *testing.T) {
	left := json.RawMessage(`[{"id":7,"status":"К оплате"}]`)
	right := json.RawMessage(`[{"status":"К оплате","id":7}]`)
	if !snapshotsEqual(left, right) {
		t.Fatal("equivalent JSON snapshots were considered different")
	}
	if snapshotsEqual(left, json.RawMessage(`[{"id":7,"status":"Оплачено"}]`)) {
		t.Fatal("changed JSON snapshots were considered equal")
	}
}

func TestUndoCollectsUniqueAffectedIDs(t *testing.T) {
	change := &undoChange{Before: json.RawMessage(`[{"id":4},{"id":7}]`), After: json.RawMessage(`[{"id":4},{"id":9}]`)}
	ids, err := combinedSnapshotIDs(change)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{4, 7, 9}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("affected ids = %#v, want %#v", ids, want)
	}
}

func TestDirectChatKeyIsStable(t *testing.T) {
	if directChatKey(12, 3) != "3:12" || directChatKey(3, 12) != "3:12" {
		t.Fatal("direct chat key depends on participant order")
	}
}

func TestUniqueChatMembersIncludesCurrentAndRemovesDuplicates(t *testing.T) {
	values := uniqueChatMembers([]int64{7, 3, 7, 0, -1}, 3)
	if len(values) != 2 || values[0] != 3 || values[1] != 7 {
		t.Fatalf("members = %#v, want [3 7]", values)
	}
}

func TestChatImageMessageRoundTrip(t *testing.T) {
	name := "0123456789abcdef0123456789abcdef.png"
	stored := encodeChatMessageBody("Подпись к снимку", name)
	body, decodedName := decodeChatMessageBody(stored)
	if body != "Подпись к снимку" || decodedName != name {
		t.Fatalf("decoded image message = %q, %q", body, decodedName)
	}
	body, imageURL := chatMessagePresentation(stored, 42)
	if body != "Подпись к снимку" || imageURL != "/api/chat/conversations/42/images/"+name {
		t.Fatalf("image presentation = %q, %q", body, imageURL)
	}
}

func TestChatImageValidationRejectsPathsAndUnknownTypes(t *testing.T) {
	for _, name := range []string{"../0123456789abcdef0123456789abcdef.png", "0123456789abcdef0123456789abcdef.svg", "0123456789abcdef0123456789abcdef.jp"} {
		if validChatImageName(name) {
			t.Fatalf("unsafe image name accepted: %q", name)
		}
	}
	if extension, ok := chatImageExtension([]byte("<svg><script>alert(1)</script></svg>")); ok || extension != "" {
		t.Fatalf("SVG payload accepted as %q", extension)
	}
	if extension, ok := chatImageExtension([]byte("\x89PNG\r\n\x1a\ncontent")); !ok || extension != ".png" {
		t.Fatalf("PNG payload rejected: %q", extension)
	}
}

func TestSaveChatImagePersistsInConversationDirectory(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("CHAT_UPLOAD_DIR", directory)
	payload := []byte("\x89PNG\r\n\x1a\ncontent")
	name, err := saveChatImage(27, ".png", payload)
	if err != nil {
		t.Fatal(err)
	}
	if !validChatImageName(name) {
		t.Fatalf("generated unsafe image name: %q", name)
	}
	stored, err := os.ReadFile(filepath.Join(directory, "27", name))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, payload) {
		t.Fatalf("stored image = %q, want %q", stored, payload)
	}
}

func TestReadChatMessageInputAcceptsClipboardPNG(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("CHAT_UPLOAD_DIR", directory)
	var payload bytes.Buffer
	writer := multipart.NewWriter(&payload)
	if err := writer.WriteField("body", "  Подпись  "); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("image", "clipboard.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte("\x89PNG\r\n\x1a\ncontent")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/chat/conversations/9/messages", &payload)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	body, name, ok := (&app{}).readChatMessageInput(recorder, req, 9)
	if !ok || body != "Подпись" || !validChatImageName(name) {
		t.Fatalf("parsed image input = ok:%v body:%q name:%q response:%s", ok, body, name, recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(directory, "9", name)); err != nil {
		t.Fatal(err)
	}
}

func TestExcelDateParsing(t *testing.T) {
	for input, expected := range map[string]string{"18.07.2026": "2026-07-18", "2026-07-18": "2026-07-18"} {
		if actual := parseDate(input); actual != expected {
			t.Fatalf("parseDate(%q)=%q, want %q", input, actual, expected)
		}
	}
}

func TestExcelNumberParsingPreservesKopecks(t *testing.T) {
	for input, expected := range map[string]string{
		"60\u00a0591,67": "60591.67",
		"60,591.67":      "60591.67",
		"60.591,67":      "60591.67",
		"60591.67":       "60591.67",
	} {
		value := parseFloatPtr(input)
		if value == nil || strconv.FormatFloat(*value, 'f', 2, 64) != expected {
			t.Fatalf("parseFloatPtr(%q) = %v, want %s", input, value, expected)
		}
	}
}

func TestExcelExportDereferencesNumbers(t *testing.T) {
	days := 10
	amount := 60591.67
	if value, ok := intValue(&days).(int); !ok || value != days {
		t.Fatalf("intValue() = %#v, want numeric %d", intValue(&days), days)
	}
	if value, ok := floatValue(&amount).(float64); !ok || value != amount {
		t.Fatalf("floatValue() = %#v, want numeric %.2f", floatValue(&amount), amount)
	}
}

func TestExcelImportRequiresRoundTripTemplate(t *testing.T) {
	headers := append(append([]string{}, excelHeaders...), excelTechnicalIDHeader)
	if err := validateExcelImportHeaders(headers); err != nil {
		t.Fatalf("export headers rejected: %v", err)
	}
	if err := validateExcelImportHeaders(excelHeaders); err == nil {
		t.Fatal("legacy file without technical ID was accepted")
	}
	headers[2] = "Поставщик"
	if err := validateExcelImportHeaders(headers); err == nil {
		t.Fatal("file with changed visible headers was accepted")
	}
}

func TestExcelImportIDParsing(t *testing.T) {
	if id, err := parseExcelImportID(""); err != nil || id != nil {
		t.Fatalf("blank ID = %v, %v; want new row", id, err)
	}
	id, err := parseExcelImportID(" 42 ")
	if err != nil || id == nil || *id != 42 {
		t.Fatalf("parsed ID = %v, %v; want 42", id, err)
	}
	for _, value := range []string{"0", "-2", "unknown"} {
		if _, err := parseExcelImportID(value); err == nil {
			t.Fatalf("invalid ID %q was accepted", value)
		}
	}
}

func TestExcelExportKeepsTechnicalIDHidden(t *testing.T) {
	book := excelize.NewFile()
	defer book.Close()
	if err := book.SetSheetName("Sheet1", "Реестр"); err != nil {
		t.Fatal(err)
	}
	writeExcelTemplateMetadata(book, "Реестр")
	values := excelExportRow(obligation{ID: 42, obligationInput: obligationInput{Counterparty: "Новый контрагент"}})
	if err := book.SetSheetRow("Реестр", "A2", &values); err != nil {
		t.Fatal(err)
	}
	buffer, err := book.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	opened, err := excelize.OpenReader(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	rows, err := opened.GetRows("Реестр")
	if err != nil {
		t.Fatal(err)
	}
	if err = validateExcelImportHeaders(rows[0]); err != nil {
		t.Fatalf("generated export cannot be imported: %v", err)
	}
	if len(rows[1]) < 18 || rows[1][17] != "42" {
		t.Fatalf("technical ID row = %#v, want ID 42 in column R", rows[1])
	}
	visible, err := opened.GetColVisible("Реестр", "R")
	if err != nil || visible {
		t.Fatalf("technical column visible=%v err=%v, want hidden", visible, err)
	}
}

func TestExcelImportCollectsNewReferenceValues(t *testing.T) {
	values := importedReferences(obligationInput{Counterparty: "  Новый контрагент  ", LegalEntity: "ООО Тест", Status: "", Urgency: "Срочная"})
	want := map[string]string{"counterparties": "Новый контрагент", "legal_entities": "ООО Тест", "urgencies": "Срочная"}
	if len(values) != len(want) {
		t.Fatalf("references = %#v, want %d non-empty values", values, len(want))
	}
	for _, item := range values {
		if want[item.kind] != item.value {
			t.Fatalf("reference %s=%q, want %q", item.kind, item.value, want[item.kind])
		}
	}
}

func TestReferenceKindWhitelist(t *testing.T) {
	if normalizeReferenceKind("statuses") != "statuses" {
		t.Fatal("known reference kind rejected")
	}
	if normalizeReferenceKind("anything'); DROP TABLE users; --") != "" {
		t.Fatal("unknown reference kind accepted")
	}
}

func TestObligationUpdateAcceptsReadOnlySplitMetadata(t *testing.T) {
	req := httptest.NewRequest("PATCH", "/api/obligations/42", strings.NewReader(`{"status":"К оплате","split_group_id":"split-test","split_parent_id":12,"installment_number":2,"installment_count":3}`))
	recorder := httptest.NewRecorder()
	var payload obligationUpdateInput
	if !decodeJSON(recorder, req, &payload) {
		t.Fatalf("split metadata was rejected: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if payload.Status != "К оплате" || payload.SplitGroupID != "split-test" || payload.InstallmentNumber != 2 || payload.InstallmentCount != 3 {
		t.Fatalf("decoded payload = %#v", payload)
	}
}

func TestBuildPaymentPlanKeepsExactTotalAndMonthlyAnchor(t *testing.T) {
	start := time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC)
	plan, err := buildPaymentPlan(10000, start, paymentSplitInput{Mode: "count", Count: 3, PeriodUnit: "month", PeriodValue: 1})
	if err != nil {
		t.Fatal(err)
	}
	wantCents := []int64{3333, 3333, 3334}
	wantDates := []string{"2027-01-31", "2027-02-28", "2027-03-31"}
	var total int64
	for index, installment := range plan {
		if installment.cents != wantCents[index] || installment.Date != wantDates[index] {
			t.Fatalf("installment %d = %#v, want %d cents on %s", index+1, installment, wantCents[index], wantDates[index])
		}
		total += installment.cents
	}
	if total != 10000 {
		t.Fatalf("plan total = %d cents, want 10000", total)
	}
}

func TestBuildPaymentPlanByFixedAmountUsesRemainder(t *testing.T) {
	payment := json.Number("30.00")
	plan, err := buildPaymentPlan(10000, time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC), paymentSplitInput{Mode: "amount", PaymentAmount: &payment, PeriodUnit: "week", PeriodValue: 2})
	if err != nil {
		t.Fatal(err)
	}
	wantCents := []int64{3000, 3000, 3000, 1000}
	wantDates := []string{"2026-07-20", "2026-08-03", "2026-08-17", "2026-08-31"}
	if len(plan) != len(wantCents) {
		t.Fatalf("plan length = %d, want %d", len(plan), len(wantCents))
	}
	for index, installment := range plan {
		if installment.cents != wantCents[index] || installment.Date != wantDates[index] {
			t.Fatalf("installment %d = %#v, want %d cents on %s", index+1, installment, wantCents[index], wantDates[index])
		}
	}
}

func TestBuildPaymentPlanByPercentageAssignsAccountTypesAndExactTotal(t *testing.T) {
	plan, err := buildPaymentPlan(10001, time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC), paymentSplitInput{Mode: "percentage", PercentageParts: []paymentSplitPercentagePart{
		{Percent: json.Number("30"), AccountType: "ОМС", PlannedDate: "2026-07-20"},
		{Percent: json.Number("70"), AccountType: "Коммерция", PlannedDate: "2026-07-25"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan) != 2 {
		t.Fatalf("plan length = %d, want 2", len(plan))
	}
	if plan[0].cents != 3000 || plan[1].cents != 7001 {
		t.Fatalf("percentage amounts = %d, %d; want 3000, 7001", plan[0].cents, plan[1].cents)
	}
	if plan[0].AccountType != "ОМС" || plan[1].AccountType != "Коммерция" || plan[0].Date != "2026-07-20" || plan[1].Date != "2026-07-25" {
		t.Fatalf("percentage plan metadata = %#v", plan)
	}
	if plan[0].Percent != 30 || plan[1].Percent != 70 || plan[0].cents+plan[1].cents != 10001 {
		t.Fatalf("percentage plan does not preserve total: %#v", plan)
	}
}

func TestBuildPaymentPlanByPercentageValidatesTotalAndPrecision(t *testing.T) {
	base := []paymentSplitPercentagePart{{Percent: json.Number("30"), AccountType: "ОМС"}, {Percent: json.Number("60"), AccountType: "Коммерция"}}
	if _, err := buildPaymentPlan(10000, time.Now(), paymentSplitInput{Mode: "percentage", PercentageParts: base}); err == nil || !strings.Contains(err.Error(), "100%") {
		t.Fatalf("invalid total error = %v", err)
	}
	base[1].Percent = json.Number("70.001")
	if _, err := buildPaymentPlan(10000, time.Now(), paymentSplitInput{Mode: "percentage", PercentageParts: base}); err == nil || !strings.Contains(err.Error(), "точностью до двух знаков") {
		t.Fatalf("invalid precision error = %v", err)
	}
}

func TestMoneyTextToCentsDoesNotLoseLargeAmountKopecks(t *testing.T) {
	cents, err := moneyTextToCents("9999999999999999.99")
	if err != nil {
		t.Fatal(err)
	}
	if cents != 999999999999999999 {
		t.Fatalf("cents = %d, want 999999999999999999", cents)
	}
	if _, err := moneyTextToCents("10.001"); err == nil {
		t.Fatal("amount with fractions of a kopeck must be rejected")
	}
}

