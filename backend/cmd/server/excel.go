package main

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

var excelHeaders = []string{"Признак учета", "Дата внесения", "Контрагенты", "Юрлицо", "Статья затрат", "Приоритет", "Ответственный", "№ счета/договора", "Отсрочка дней", "Дата документа", "Сумма", "Плановая дата оплаты", "Дата утверждения оплаты", "Фактическая дата оплаты", "Статус", "Срочность", "Комментарий"}

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
	_ = f.SetSheetRow(sheet, "A1", &excelHeaders)
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
		values := []any{item.AccountType, dateValue(item.EntryDate), item.Counterparty, item.LegalEntity, item.CostCategory, item.Priority, item.Responsible, item.DocumentNumber, item.DefermentDays, dateValue(item.DocumentDate), item.Amount, dateValue(item.PlannedPaymentDate), dateValue(item.ApprovalDate), dateValue(item.ActualPaymentDate), item.Status, item.Urgency, item.Comment}
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
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Ошибка базы данных")
		return
	}
	defer tx.Rollback()
	user := currentUser(r)
	imported := 0
	commentMap := map[string]string{}
	if comments, commentErr := book.GetComments(sheet); commentErr == nil {
		for _, comment := range comments {
			commentMap[comment.Cell] = comment.Text
		}
	}
	for index, row := range rows[1:] {
		if len(row) < 17 {
			row = append(row, make([]string, 17-len(row))...)
		}
		if allEmpty(row[:17]) {
			continue
		}
		deferment := parseIntPtr(row[8])
		amount := parseFloatPtr(row[10])
		input := obligationInput{SourceRow: index + 2, AccountType: row[0], EntryDate: parseDate(row[1]), Counterparty: row[2], LegalEntity: row[3], CostCategory: row[4], Priority: row[5], Responsible: row[6], DocumentNumber: row[7], DefermentDays: deferment, DocumentDate: parseDate(row[9]), Amount: amount, PlannedPaymentDate: parseDate(row[11]), ApprovalDate: parseDate(row[12]), ActualPaymentDate: parseDate(row[13]), Status: row[14], Urgency: row[15], Comment: row[16]}
		input.SourceNote = commentMap[fmt.Sprintf("H%d", index+2)]
		if _, err = insertObligation(r.Context(), tx, input, &user.ID); err != nil {
			fail(w, 400, fmt.Sprintf("Ошибка в строке %d: %v", index+2, err))
			return
		}
		imported++
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить импорт")
		return
	}
	a.audit(r.Context(), user.ID, "import", "obligation", nil, map[string]any{"count": imported})
	writeJSON(w, 200, map[string]any{"imported": imported})
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
	value = strings.ReplaceAll(value, ",", ".")
	if value == "" {
		return nil
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
