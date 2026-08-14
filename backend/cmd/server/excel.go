package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

var excelHeaders = []string{"Признак учета", "Дата внесения", "Контрагенты", "Юрлицо", "Статья затрат", "Приоритет", "Ответственный", "№ счета/договора", "Отсрочка дней", "Дата документа", "Сумма", "Плановая дата оплаты", "Дата утверждения оплаты", "Фактическая дата оплаты", "Статус", "Срочность", "Комментарий"}

const excelTechnicalIDHeader = "_registry_id"

func (a *app) exportXLSX(w http.ResponseWriter, r *http.Request) {
	where, args := buildFilters(r, 1)
	rows, err := a.db.QueryContext(r.Context(), "SELECT "+obligationColumns+" FROM obligations WHERE "+where+" ORDER BY id", args...)
	if err != nil {
		fail(w, 500, "Не удалось экспортировать реестр")
		return
	}
	defer rows.Close()
	f := excelize.NewFile()
	defer f.Close()
	sheet := "Реестр"
	_ = f.SetSheetName("Sheet1", sheet)
	writeExcelTemplateMetadata(f, sheet)
	headerStyle, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Color: "FFFFFF"}, Fill: excelize.Fill{Type: "pattern", Color: []string{"1F4E78"}, Pattern: 1}, Alignment: &excelize.Alignment{Vertical: "center", WrapText: true}})
	_ = f.SetCellStyle(sheet, "A1", "Q1", headerStyle)
	_ = f.SetRowHeight(sheet, 1, 34)
	dateStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 14})
	moneyStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 4})
	rowNumber := 2
	for rows.Next() {
		item, err := scanObligation(rows)
		if err != nil {
			log.Printf("export scan obligation: %v", err)
			fail(w, 500, "Ошибка экспорта")
			return
		}
		values := excelExportRow(item)
		cell, _ := excelize.CoordinatesToCellName(1, rowNumber)
		_ = f.SetSheetRow(sheet, cell, &values)
		if item.SourceNote != "" {
			_ = f.AddComment(sheet, excelize.Comment{Cell: fmt.Sprintf("H%d", rowNumber), Author: "Из исходного реестра", Text: item.SourceNote, Width: 260, Height: 80})
		}
		rowNumber++
	}
	if rowNumber > 2 {
		_ = f.SetCellStyle(sheet, "B2", fmt.Sprintf("B%d", rowNumber-1), dateStyle)
		for _, col := range []string{"J", "L", "M", "N"} {
			_ = f.SetCellStyle(sheet, col+"2", fmt.Sprintf("%s%d", col, rowNumber-1), dateStyle)
		}
		_ = f.SetCellStyle(sheet, "K2", fmt.Sprintf("K%d", rowNumber-1), moneyStyle)
		_ = f.AutoFilter(sheet, fmt.Sprintf("A1:Q%d", rowNumber-1), nil)
	}
	_ = f.SetPanes(sheet, &excelize.Panes{Freeze: true, Split: true, XSplit: 4, YSplit: 1, TopLeftCell: "E2", ActivePane: "bottomRight"})
	widths := []float64{15, 13, 26, 22, 34, 13, 20, 28, 14, 14, 16, 17, 18, 18, 20, 14, 42}
	for index, width := range widths {
		col, _ := excelize.ColumnNumberToName(index + 1)
		_ = f.SetColWidth(sheet, col, col, width)
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="registry.xlsx"`)
	if err := f.Write(w); err != nil {
		return
	}
}

func writeExcelTemplateMetadata(file *excelize.File, sheet string) {
	headers := append(append([]string{}, excelHeaders...), excelTechnicalIDHeader)
	_ = file.SetSheetRow(sheet, "A1", &headers)
	_ = file.SetColVisible(sheet, "R", false)
}

func excelExportRow(item obligation) []any {
	return []any{item.AccountType, dateValue(item.EntryDate), item.Counterparty, item.LegalEntity, item.CostCategory, item.Priority, item.Responsible, item.DocumentNumber, intValue(item.DefermentDays), dateValue(item.DocumentDate), floatValue(item.Amount), dateValue(item.PlannedPaymentDate), dateValue(item.ApprovalDate), dateValue(item.ActualPaymentDate), item.Status, item.Urgency, item.Comment, item.ID}
}

func intValue(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func floatValue(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func dateValue(value string) any {
	if value == "" {
		return nil
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return value
	}
	return parsed
}

func (a *app) importXLSX(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 30<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		fail(w, 400, "Выберите файл .xlsx")
		return
	}
	defer file.Close()
	allowDuplicate := strings.EqualFold(strings.TrimSpace(r.FormValue("allow_duplicate")), "true")
	book, err := excelize.OpenReader(file)
	if err != nil {
		fail(w, 400, "Не удалось прочитать Excel: "+err.Error())
		return
	}
	defer book.Close()
	sheet := "Реестр"
	if index, _ := book.GetSheetIndex(sheet); index < 0 {
		sheet = book.GetSheetName(0)
	}
	rows, err := book.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		fail(w, 400, "Лист реестра пуст")
		return
	}
	if err = validateExcelImportHeaders(rows[0]); err != nil {
		fail(w, 400, err.Error())
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Ошибка базы данных")
		return
	}
	defer tx.Rollback()
	if err = acquireDuplicateWriteLock(r.Context(), tx); err != nil {
		fail(w, 500, "Не удалось подготовить проверку дублей")
		return
	}
	user := currentUser(r)
	referencesBefore, err := snapshotAllReferences(r.Context(), tx)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	created := 0
	updated := 0
	beforeRows := []json.RawMessage{}
	touchedIDs := []int64{}
	seenIDs := map[int64]struct{}{}
	commentMap := map[string]string{}
	if comments, commentErr := book.GetComments(sheet); commentErr == nil {
		for _, comment := range comments {
			commentMap[comment.Cell] = comment.Text
		}
	}
	for index, row := range rows[1:] {
		if len(row) < len(excelHeaders)+1 {
			row = append(row, make([]string, len(excelHeaders)+1-len(row))...)
		}
		if allEmpty(row[:17]) {
			continue
		}
		deferment := parseIntPtr(row[8])
		amount := parseFloatPtr(row[10])
		input := obligationInput{SourceRow: index + 2, AccountType: row[0], EntryDate: parseDate(row[1]), Counterparty: row[2], LegalEntity: row[3], CostCategory: row[4], Priority: row[5], Responsible: row[6], DocumentNumber: row[7], DefermentDays: deferment, DocumentDate: parseDate(row[9]), Amount: amount, PlannedPaymentDate: parseDate(row[11]), ApprovalDate: parseDate(row[12]), ActualPaymentDate: parseDate(row[13]), Status: row[14], Urgency: row[15], Comment: row[16]}
		input.SourceNote = commentMap[fmt.Sprintf("H%d", index+2)]
		input.normalize()
		id, idErr := parseExcelImportID(row[len(excelHeaders)])
		if idErr != nil {
			fail(w, 400, fmt.Sprintf("Ошибка в строке %d: %v", index+2, idErr))
			return
		}
		if id != nil {
			if _, duplicate := seenIDs[*id]; duplicate {
				fail(w, 400, fmt.Sprintf("Ошибка в строке %d: ID %d встречается в файле повторно", index+2, *id))
				return
			}
			seenIDs[*id] = struct{}{}
		}
		if err = syncImportedReferences(r.Context(), tx, input); err != nil {
			fail(w, 400, fmt.Sprintf("Ошибка справочников в строке %d: %v", index+2, err))
			return
		}
		if id == nil {
			if approvalErr := validateApprovalCreate(user, input); approvalErr != nil {
				fail(w, http.StatusForbidden, fmt.Sprintf("Ошибка в строке %d: %v", index+2, approvalErr))
				return
			}
			duplicates, duplicateErr := findDuplicateObligations(r.Context(), tx, input, 0, "")
			if duplicateErr != nil {
				fail(w, 500, fmt.Sprintf("Не удалось проверить строку %d на дублирование", index+2))
				return
			}
			if duplicates.Total > 0 && !allowDuplicate {
				writeDuplicateConflict(w, duplicates, fmt.Sprintf("excel_row_%d", index+2))
				return
			}
			var createdID int64
			if createdID, err = insertObligation(r.Context(), tx, input, &user.ID); err != nil {
				fail(w, 400, fmt.Sprintf("Ошибка в строке %d: %v", index+2, err))
				return
			}
			touchedIDs = append(touchedIDs, createdID)
			created++
		} else {
			beforeRow, snapshotErr := snapshotOneObligation(r.Context(), tx, *id)
			if snapshotErr != nil {
				fail(w, 400, fmt.Sprintf("Ошибка в строке %d: запись с ID %d не найдена в базе", index+2, *id))
				return
			}
			beforeRows = append(beforeRows, beforeRow)
			previous, approvalErr := approvalStateFromSnapshot(beforeRow)
			if approvalErr != nil {
				fail(w, 500, fmt.Sprintf("Не удалось проверить согласование в строке %d", index+2))
				return
			}
			if approvalErr = validateApprovalUpdate(user, previous, input); approvalErr != nil {
				fail(w, http.StatusForbidden, fmt.Sprintf("Ошибка в строке %d: %v", index+2, approvalErr))
				return
			}
			touchedIDs = append(touchedIDs, *id)
			existing, splitGroupID, identityErr := loadDuplicateIdentity(r.Context(), tx, *id)
			if identityErr != nil {
				fail(w, 400, fmt.Sprintf("Ошибка в строке %d: запись с ID %d не найдена в базе", index+2, *id))
				return
			}
			if duplicateIdentityChanged(existing, input) {
				duplicates, duplicateErr := findDuplicateObligations(r.Context(), tx, input, *id, splitGroupID)
				if duplicateErr != nil {
					fail(w, 500, fmt.Sprintf("Не удалось проверить строку %d на дублирование", index+2))
					return
				}
				if duplicates.Total > 0 && !allowDuplicate {
					writeDuplicateConflict(w, duplicates, fmt.Sprintf("excel_row_%d", index+2))
					return
				}
			}
			result, updateErr := tx.ExecContext(r.Context(), `UPDATE obligations SET account_type=$1,entry_date=NULLIF($2,'')::date,counterparty=$3,legal_entity=$4,cost_category=$5,priority=$6,responsible=$7,document_number=$8,deferment_days=$9,document_date=NULLIF($10,'')::date,amount=$11,planned_payment_date=NULLIF($12,'')::date,approval_date=NULLIF($13,'')::date,actual_payment_date=NULLIF($14,'')::date,status=$15,urgency=$16,comment=$17,source_note=$18,updated_by=$19,updated_at=now() WHERE id=$20`, nullable(input.AccountType), nullable(input.EntryDate), nullable(input.Counterparty), nullable(input.LegalEntity), nullable(input.CostCategory), nullable(input.Priority), nullable(input.Responsible), nullable(input.DocumentNumber), input.DefermentDays, nullable(input.DocumentDate), input.Amount, nullable(input.PlannedPaymentDate), nullable(input.ApprovalDate), nullable(input.ActualPaymentDate), nullable(input.Status), nullable(input.Urgency), nullable(input.Comment), nullable(input.SourceNote), user.ID, *id)
			if updateErr != nil {
				fail(w, 400, fmt.Sprintf("Ошибка обновления строки %d: %v", index+2, updateErr))
				return
			}
			affected, _ := result.RowsAffected()
			if affected == 0 {
				fail(w, 400, fmt.Sprintf("Ошибка в строке %d: запись с ID %d не найдена в базе", index+2, *id))
				return
			}
			updated++
		}
	}
	before, err := snapshotArray(beforeRows)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	after, err := snapshotRows(r.Context(), tx, "obligations", touchedIDs)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	referencesAfter, err := snapshotAllReferences(r.Context(), tx)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	payload := undoPayload{Obligations: &undoChange{Before: before, After: after}}
	if !snapshotsEqual(referencesBefore, referencesAfter) {
		payload.References = &undoChange{Before: referencesBefore, After: referencesAfter}
	}
	if err = a.recordUndo(r.Context(), tx, user.ID, "import", fmt.Sprintf("Импорт: %d изменено, %d добавлено", updated, created), payload); err != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить импорт")
		return
	}
	total := created + updated
	a.audit(r.Context(), user.ID, "import", "obligation", nil, map[string]any{"count": total, "created": created, "updated": updated})
	writeJSON(w, 200, map[string]any{"imported": total, "created": created, "updated": updated})
}

func validateExcelImportHeaders(row []string) error {
	if len(row) < len(excelHeaders)+1 || strings.TrimSpace(row[len(excelHeaders)]) != excelTechnicalIDHeader {
		return fmt.Errorf("Файл не содержит служебные данные реестра. Сначала скачайте новый файл кнопкой Excel")
	}
	for index, expected := range excelHeaders {
		if strings.TrimSpace(row[index]) != expected {
			return fmt.Errorf("Неверный формат колонки %d: ожидается «%s»", index+1, expected)
		}
	}
	return nil
}

func parseExcelImportID(value string) (*int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return nil, fmt.Errorf("некорректный служебный ID")
	}
	return &id, nil
}

type importedReference struct{ kind, value string }

func importedReferences(input obligationInput) []importedReference {
	values := []importedReference{
		{"account_types", input.AccountType}, {"counterparties", input.Counterparty},
		{"legal_entities", input.LegalEntity}, {"cost_categories", input.CostCategory},
		{"priorities", input.Priority}, {"responsibles", input.Responsible},
		{"statuses", input.Status}, {"urgencies", input.Urgency},
	}
	result := make([]importedReference, 0, len(values))
	for _, item := range values {
		item.value = strings.TrimSpace(item.value)
		if item.value != "" {
			result = append(result, item)
		}
	}
	return result
}

func syncImportedReferences(ctx context.Context, db dbExecer, input obligationInput) error {
	for _, item := range importedReferences(input) {
		if _, err := db.ExecContext(ctx, `INSERT INTO reference_values(kind,value,sort_order) VALUES($1,$2,(SELECT COALESCE(max(sort_order),-1)+1 FROM reference_values WHERE kind=$1)) ON CONFLICT(kind,value) DO UPDATE SET active=true`, item.kind, item.value); err != nil {
			return err
		}
	}
	return nil
}

func allEmpty(values []string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}
func parseIntPtr(value string) *int {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	number, err := strconv.Atoi(strings.Split(value, ".")[0])
	if err != nil {
		return nil
	}
	return &number
}
func parseFloatPtr(value string) *float64 {
	value = strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), " ", ""), " ", "")
	if value == "" {
		return nil
	}
	comma := strings.LastIndex(value, ",")
	dot := strings.LastIndex(value, ".")
	switch {
	case comma >= 0 && dot >= 0 && comma > dot:
		value = strings.ReplaceAll(value, ".", "")
		value = strings.ReplaceAll(value, ",", ".")
	case comma >= 0 && dot >= 0:
		value = strings.ReplaceAll(value, ",", "")
	case comma >= 0:
		value = strings.ReplaceAll(value, ",", ".")
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return nil
	}
	return &number
}
func parseDate(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	for _, layout := range []string{"2006-01-02", "02.01.2006", "02/01/2006", "2006-01-02 00:00:00", "1/2/06", "1/2/2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Format("2006-01-02")
		}
	}
	if serial, err := strconv.ParseFloat(value, 64); err == nil {
		if parsed, err := excelize.ExcelDateToTime(serial, false); err == nil {
			return parsed.Format("2006-01-02")
		}
	}
	return value
}
