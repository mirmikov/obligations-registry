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

func TestBuildFiltersSupportsBlankAccountType(t *testing.T) {
	r := httptest.NewRequest("GET", "/?account_type="+blankAccountTypeFilter, nil)
	where, args := buildFilters(r, 1)
	if len(args) != 0 {
		t.Fatalf("blank account type args = %#v, want none", args)
	}
	if !strings.Contains(where, "NULLIF(BTRIM(account_type),'') IS NULL") {
		t.Fatalf("filter SQL %q does not select blank account types", where)
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

func TestNormalizeWorkspaceStateAcceptsExecutiveDashboard(t *testing.T) {
	value := normalizeWorkspaceState(workspaceState{Page: "executive"})
	if value.Page != "executive" {
		t.Fatalf("workspace state = %#v", value)
	}
}

func TestExecutivePeriodDefinitionsUseCalendarBoundaries(t *testing.T) {
	reportDate := time.Date(2026, time.July, 22, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		key, from, to string
	}{
		{key: "overdue", to: "2026-07-21"},
		{key: "week", from: "2026-07-22", to: "2026-07-26"},
		{key: "month", from: "2026-07-22", to: "2026-07-31"},
	}
	for _, test := range tests {
		period, clause, ok := executivePeriodDefinition(test.key, reportDate)
		if !ok || clause == "" || period.From != test.from || period.To != test.to {
			t.Fatalf("%s period = %#v, clause=%q, ok=%v", test.key, period, clause, ok)
		}
	}
	if _, _, ok := executivePeriodDefinition("quarter", reportDate); ok {
		t.Fatal("unknown executive period accepted")
	}
}

func TestExecutiveFiltersSupportAllRegisteredAndPayableStatuses(t *testing.T) {
	filter := executiveBaseFilter("planned_payment_date < $1::date")
	for _, expected := range []string{"$4=''", "Зарегистрирован", "Зарегистрировано", "К оплате", "$4", "$5", "planned_payment_date < $1::date", "legal_entity=$2", "account_type=$3", blankAccountTypeFilter, "NULLIF(BTRIM(account_type),'') IS NULL", executiveSpecialMatchSQL} {
		if !strings.Contains(filter, expected) {
			t.Fatalf("executive filter %q does not contain %q", filter, expected)
		}
	}
	for _, forbidden := range []string{"Оплачено", "Отменено"} {
		if strings.Contains(filter, forbidden) {
			t.Fatalf("executive filter includes forbidden status %q", forbidden)
		}
	}
}

func TestExecutiveSpecialSectionMatchesRentAndKibirevWithoutDependingOnSpaces(t *testing.T) {
	for _, expected := range []string{"cost_category", "Аренда", "counterparty", "ИП Кибирев О. А.", "REGEXP_REPLACE", "[[:space:]]+"} {
		if !strings.Contains(executiveSpecialMatchSQL, expected) {
			t.Fatalf("special section matcher does not contain %q: %s", expected, executiveSpecialMatchSQL)
		}
	}
}

func TestExecutiveSpecialSectionUsesSameFiltersAndMonthHorizon(t *testing.T) {
	filter := executiveSpecialBaseFilter()
	for _, expected := range []string{"date_trunc('month',$1::date)", "legal_entity=$2", "account_type=$3", "$4", executiveSpecialMatchSQL} {
		if !strings.Contains(filter, expected) {
			t.Fatalf("special section filter does not contain %q: %s", expected, filter)
		}
	}
}

func TestExecutiveSettingsAreKeptOutOfUserReferences(t *testing.T) {
	if normalizeReferenceKind(executiveSettingsReferenceKind) != "" {
		t.Fatal("internal executive settings must not be editable through reference endpoints")
	}
}

func TestParseExecutiveFiltersDefaultsAndValidatesStatus(t *testing.T) {
	defaultRequest := httptest.NewRequest("GET", "/?as_of=2026-07-29", nil)
	filters, _, err := parseExecutiveFilters(defaultRequest)
	if err != nil || filters.Status != "" {
		t.Fatalf("default status=%q err=%v", filters.Status, err)
	}

	payableRequest := httptest.NewRequest("GET", "/?as_of=2026-07-29&status=%D0%9A+%D0%BE%D0%BF%D0%BB%D0%B0%D1%82%D0%B5", nil)
	filters, _, err = parseExecutiveFilters(payableRequest)
	if err != nil || filters.Status != executivePayableStatus {
		t.Fatalf("payable status=%q err=%v", filters.Status, err)
	}

	invalidRequest := httptest.NewRequest("GET", "/?as_of=2026-07-29&status=%D0%9E%D0%BF%D0%BB%D0%B0%D1%87%D0%B5%D0%BD%D0%BE", nil)
	if _, _, err = parseExecutiveFilters(invalidRequest); err == nil {
		t.Fatal("unsupported executive status accepted")
	}
}

func TestBulkUpdateCanExplicitlyClearApprovalDate(t *testing.T) {
	if !strings.Contains(bulkUpdateSQL, "WHEN $2 THEN NULLIF($3,'')::date") {
		t.Fatalf("bulk update cannot explicitly clear approval date: %s", bulkUpdateSQL)
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

func TestObligationHistoryBuildsFieldLevelChanges(t *testing.T) {
	before := map[string]any{"id": float64(42), "status": "Зарегистрирован", "amount": float64(1000), "comment": ""}
	after := map[string]any{"id": float64(42), "status": "К оплате", "amount": float64(1200), "comment": "Согласовано"}
	changes := obligationHistoryChanges(before, after)
	if len(changes) != 3 {
		t.Fatalf("history changes=%#v, want 3 changes", changes)
	}
	got := map[string]obligationHistoryChange{}
	for _, change := range changes {
		got[change.Field] = change
	}
	if got["status"].Before != "Зарегистрирован" || got["status"].After != "К оплате" {
		t.Fatalf("status change=%#v", got["status"])
	}
	if got["comment"].After != "Согласовано" {
		t.Fatalf("comment change=%#v", got["comment"])
	}
}

func TestObligationHistoryFindsRowInUndoSnapshot(t *testing.T) {
	raw := json.RawMessage(`[{"id":41,"status":"Оплачено"},{"id":42,"status":"К оплате"}]`)
	row := snapshotObjectForID(raw, 42)
	if row == nil || row["status"] != "К оплате" {
		t.Fatalf("snapshot row=%#v", row)
	}
	if snapshotObjectForID(raw, 99) != nil {
		t.Fatal("unknown obligation found in snapshot")
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

func TestAutomaticPaymentStatus(t *testing.T) {
	for _, test := range []struct {
		name       string
		actualDate string
		status     string
		want       string
	}{
		{name: "filled date marks paid", actualDate: "2026-07-29", status: "К оплате", want: "Оплачено"},
		{name: "spaces around date mark paid", actualDate: " 2026-07-29 ", status: "Зарегистрирован", want: "Оплачено"},
		{name: "empty date preserves status", actualDate: "", status: "К оплате", want: "К оплате"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := automaticPaymentStatus(test.actualDate, test.status); got != test.want {
				t.Fatalf("automaticPaymentStatus(%q, %q)=%q, want %q", test.actualDate, test.status, got, test.want)
			}
		})
	}
}

func TestObligationNormalizeMarksActualPaymentAsPaid(t *testing.T) {
	input := obligationInput{EntryDate: "2026-07-20", ActualPaymentDate: "2026-07-29", Status: "К оплате"}
	input.normalize()
	if input.Status != "Оплачено" {
		t.Fatalf("normalized status=%q, want Оплачено", input.Status)
	}
}

func TestBuildPaymentPlanEqualPartsKeepsExactTotalWithCustomDates(t *testing.T) {
	start := time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC)
	wantDates := []string{"2027-01-31", "2027-02-15", "2027-03-08"}
	plan, err := buildPaymentPlan(10000, start, paymentSplitInput{Mode: "count", Count: 3, PaymentDates: wantDates})
	if err != nil {
		t.Fatal(err)
	}
	wantCents := []int64{3333, 3333, 3334}
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

func TestBuildPaymentPlanEqualPartsValidatesCustomDates(t *testing.T) {
	start := time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC)
	if _, err := buildPaymentPlan(10000, start, paymentSplitInput{Mode: "count", Count: 3, PaymentDates: []string{"2027-01-31"}}); err == nil || !strings.Contains(err.Error(), "Количество дат") {
		t.Fatalf("date count error = %v", err)
	}
	if _, err := buildPaymentPlan(10000, start, paymentSplitInput{Mode: "count", Count: 2, PaymentDates: []string{"2027-01-31", "not-a-date"}}); err == nil || !strings.Contains(err.Error(), "дата платежа 2") {
		t.Fatalf("invalid date error = %v", err)
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
