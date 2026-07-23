package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type obligationInput struct {
	SourceRow          int      `json:"source_row,omitempty"`
	AccountType        string   `json:"account_type"`
	EntryDate          string   `json:"entry_date"`
	Counterparty       string   `json:"counterparty"`
	LegalEntity        string   `json:"legal_entity"`
	CostCategory       string   `json:"cost_category"`
	Priority           string   `json:"priority"`
	Responsible        string   `json:"responsible"`
	DocumentNumber     string   `json:"document_number"`
	DefermentDays      *int     `json:"deferment_days"`
	DocumentDate       string   `json:"document_date"`
	Amount             *float64 `json:"amount"`
	PlannedPaymentDate string   `json:"planned_payment_date"`
	ApprovalDate       string   `json:"approval_date"`
	ActualPaymentDate  string   `json:"actual_payment_date"`
	Status             string   `json:"status"`
	Urgency            string   `json:"urgency"`
	Comment            string   `json:"comment"`
	SourceNote         string   `json:"source_note"`
}

// obligationUpdateInput accepts read-only schedule metadata returned by the API.
// Older open frontend tabs can send it back while editing a regular cell; the
// values are intentionally ignored so clients cannot alter schedule links.
type obligationUpdateInput struct {
	obligationInput
	SplitGroupID      string `json:"split_group_id"`
	SplitParentID     *int64 `json:"split_parent_id"`
	InstallmentNumber int    `json:"installment_number"`
	InstallmentCount  int    `json:"installment_count"`
}

type obligation struct {
	ID int64 `json:"id"`
	obligationInput
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
	Overdue           bool   `json:"overdue"`
	DueSoon           bool   `json:"due_soon"`
	SplitGroupID      string `json:"split_group_id"`
	SplitParentID     *int64 `json:"split_parent_id"`
	InstallmentNumber int    `json:"installment_number"`
	InstallmentCount  int    `json:"installment_count"`
}

const obligationColumns = `id,COALESCE(source_row,0),COALESCE(account_type,''),COALESCE(to_char(entry_date,'YYYY-MM-DD'),''),COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(cost_category,''),COALESCE(priority,''),COALESCE(responsible,''),COALESCE(document_number,''),deferment_days,COALESCE(to_char(document_date,'YYYY-MM-DD'),''),amount::float8,COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),COALESCE(to_char(approval_date,'YYYY-MM-DD'),''),COALESCE(to_char(actual_payment_date,'YYYY-MM-DD'),''),COALESCE(status,''),COALESCE(urgency,''),COALESCE(comment,''),COALESCE(source_note,''),to_char(created_at,'YYYY-MM-DD HH24:MI'),to_char(updated_at,'YYYY-MM-DD HH24:MI'),COALESCE(planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено'),false),COALESCE(planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+3 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено'),false),COALESCE(split_group_id,''),split_parent_id,COALESCE(installment_number,0),COALESCE(installment_count,0)`

type scanner interface{ Scan(...any) error }

func scanObligation(row scanner) (obligation, error) {
	var item obligation
	err := row.Scan(&item.ID, &item.SourceRow, &item.AccountType, &item.EntryDate, &item.Counterparty, &item.LegalEntity, &item.CostCategory, &item.Priority, &item.Responsible, &item.DocumentNumber, &item.DefermentDays, &item.DocumentDate, &item.Amount, &item.PlannedPaymentDate, &item.ApprovalDate, &item.ActualPaymentDate, &item.Status, &item.Urgency, &item.Comment, &item.SourceNote, &item.CreatedAt, &item.UpdatedAt, &item.Overdue, &item.DueSoon, &item.SplitGroupID, &item.SplitParentID, &item.InstallmentNumber, &item.InstallmentCount)
	return item, err
}

func buildFilters(r *http.Request, start int) (string, []any) {
	query := r.URL.Query()
	clauses := []string{"1=1"}
	args := []any{}
	add := func(sqlPart string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(sqlPart, start+len(args)-1))
	}
	for _, filter := range []struct{ param, column string }{
		{"account_type", "account_type"}, {"legal_entity", "legal_entity"}, {"cost_category", "cost_category"}, {"priority", "priority"}, {"responsible", "responsible"}, {"status", "status"}, {"urgency", "urgency"},
	} {
		if value := strings.TrimSpace(query.Get(filter.param)); value != "" {
			add(filter.column+"=$%d", value)
		}
	}
	counterparties := []string{}
	seenCounterparties := map[string]bool{}
	for _, raw := range query["counterparty"] {
		value := strings.TrimSpace(raw)
		if value != "" && !seenCounterparties[value] {
			counterparties = append(counterparties, value)
			seenCounterparties[value] = true
		}
	}
	if len(counterparties) > 0 {
		add("counterparty=ANY($%d::text[])", counterparties)
	}
	if q := strings.TrimSpace(query.Get("q")); q != "" {
		add(`concat_ws(' ',counterparty,document_number,comment,responsible,legal_entity,cost_category) ILIKE '%%'||$%d||'%%'`, q)
	}
	if value := query.Get("planned_from"); value != "" {
		add("planned_payment_date >= $%d::date", value)
	}
	if value := query.Get("planned_to"); value != "" {
		add("planned_payment_date <= $%d::date", value)
	}
	if value := query.Get("document_from"); value != "" {
		add("document_date >= $%d::date", value)
	}
	if value := query.Get("document_to"); value != "" {
		add("document_date <= $%d::date", value)
	}
	for _, filter := range []struct{ param, column string }{
		{"entry_date", "entry_date"}, {"document_date", "document_date"}, {"planned_payment_date", "planned_payment_date"}, {"approval_date", "approval_date"}, {"actual_payment_date", "actual_payment_date"},
	} {
		if value := strings.TrimSpace(query.Get(filter.param)); value != "" {
			add(filter.column+" = $%d::date", value)
		}
	}
	if query.Get("overdue") == "true" {
		clauses = append(clauses, "planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')")
	}
	return strings.Join(clauses, " AND "), args
}

func (a *app) listObligations(w http.ResponseWriter, r *http.Request) {
	page, pageSize := queryInt(r, "page", 1, 100000), queryInt(r, "page_size", 50, 200)
	where, args := buildFilters(r, 1)
	sortColumns := map[string]string{"entry_date": "entry_date", "counterparty": "counterparty", "legal_entity": "legal_entity", "amount": "amount", "planned_payment_date": "planned_payment_date", "approval_date": "approval_date", "status": "status", "priority": "priority", "updated_at": "updated_at"}
	sort := sortColumns[r.URL.Query().Get("sort")]
	if sort == "" {
		sort = "id"
	}
	direction := "DESC"
	if strings.EqualFold(r.URL.Query().Get("order"), "asc") {
		direction = "ASC"
	}
	var total int
	if err := a.db.QueryRowContext(r.Context(), "SELECT count(*) FROM obligations WHERE "+where, args...).Scan(&total); err != nil {
		fail(w, 500, "Не удалось загрузить реестр")
		return
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := a.db.QueryContext(r.Context(), fmt.Sprintf("SELECT %s FROM obligations WHERE %s ORDER BY %s %s NULLS LAST,id DESC LIMIT $%d OFFSET $%d", obligationColumns, where, sort, direction, len(args)-1, len(args)), args...)
	if err != nil {
		fail(w, 500, "Не удалось загрузить реестр")
		return
	}
	defer rows.Close()
	items := []obligation{}
	for rows.Next() {
		item, err := scanObligation(rows)
		if err != nil {
			log.Printf("scan obligation: %v", err)
			fail(w, 500, "Ошибка чтения реестра")
			return
		}
		items = append(items, item)
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": pageSize})
}

func (a *app) createObligation(w http.ResponseWriter, r *http.Request) {
	var input obligationInput
	if !decodeJSON(w, r, &input) {
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	id, err := insertObligation(r.Context(), tx, input, &user.ID)
	if err != nil {
		fail(w, 400, "Не удалось добавить обязательство: "+err.Error())
		return
	}
	after, err := snapshotRows(r.Context(), tx, "obligations", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "create", fmt.Sprintf("Создание обязательства №%d", id), undoPayload{Obligations: &undoChange{Before: emptySnapshot(), After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "create", "obligation", &id, input)
	writeJSON(w, 201, map[string]any{"id": id})
}

func (a *app) updateObligation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "Некорректный ID")
		return
	}
	var payload obligationUpdateInput
	if !decodeJSON(w, r, &payload) {
		return
	}
	input := payload.obligationInput
	input.normalize()
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	beforeRow, err := snapshotOneObligation(r.Context(), tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Запись не найдена")
		return
	}
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	before, _ := snapshotArray([]json.RawMessage{beforeRow})
	result, err := tx.ExecContext(r.Context(), `UPDATE obligations SET account_type=$1,entry_date=NULLIF($2,'')::date,counterparty=$3,legal_entity=$4,cost_category=$5,priority=$6,responsible=$7,document_number=$8,deferment_days=$9,document_date=NULLIF($10,'')::date,amount=$11,planned_payment_date=NULLIF($12,'')::date,approval_date=NULLIF($13,'')::date,actual_payment_date=NULLIF($14,'')::date,status=$15,urgency=$16,comment=$17,source_note=$18,updated_by=$19,updated_at=now() WHERE id=$20`, nullable(input.AccountType), nullable(input.EntryDate), nullable(input.Counterparty), nullable(input.LegalEntity), nullable(input.CostCategory), nullable(input.Priority), nullable(input.Responsible), nullable(input.DocumentNumber), input.DefermentDays, nullable(input.DocumentDate), input.Amount, nullable(input.PlannedPaymentDate), nullable(input.ApprovalDate), nullable(input.ActualPaymentDate), nullable(input.Status), nullable(input.Urgency), nullable(input.Comment), nullable(input.SourceNote), user.ID, id)
	if err != nil {
		fail(w, 400, "Не удалось сохранить: "+err.Error())
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		fail(w, 404, "Запись не найдена")
		return
	}
	after, err := snapshotRows(r.Context(), tx, "obligations", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "update", fmt.Sprintf("Изменение обязательства №%d", id), undoPayload{Obligations: &undoChange{Before: before, After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "update", "obligation", &id, input)
	writeJSON(w, 200, map[string]any{"id": id})
}

func (a *app) deleteObligation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "Некорректный ID")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать удаление")
		return
	}
	defer tx.Rollback()
	beforeRow, err := snapshotOneObligation(r.Context(), tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Запись не найдена")
		return
	}
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	before, _ := snapshotArray([]json.RawMessage{beforeRow})
	result, err := tx.ExecContext(r.Context(), "DELETE FROM obligations WHERE id=$1", id)
	if err != nil {
		fail(w, 500, "Не удалось удалить")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		fail(w, 404, "Запись не найдена")
		return
	}
	if a.recordUndo(r.Context(), tx, user.ID, "delete", fmt.Sprintf("Удаление обязательства №%d", id), undoPayload{Obligations: &undoChange{Before: before, After: emptySnapshot()}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить удаление")
		return
	}
	a.audit(r.Context(), user.ID, "delete", "obligation", &id, map[string]any{})
	w.WriteHeader(204)
}

func (a *app) bulkUpdate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs               []int64 `json:"ids"`
		Status            string  `json:"status"`
		ApprovalDate      string  `json:"approval_date"`
		ActualPaymentDate string  `json:"actual_payment_date"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.IDs) == 0 {
		fail(w, 400, "Не выбраны строки")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать массовое изменение")
		return
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM (SELECT id FROM obligations WHERE id=ANY($1) FOR UPDATE) locked`, input.IDs).Scan(new(int)); err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	before, err := snapshotRows(r.Context(), tx, "obligations", input.IDs)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE obligations SET status=CASE WHEN $1='' THEN status ELSE $1 END,approval_date=CASE WHEN $2='' THEN approval_date ELSE $2::date END,actual_payment_date=CASE WHEN $3='' THEN actual_payment_date ELSE $3::date END,updated_by=$4,updated_at=now() WHERE id=ANY($5)`, input.Status, input.ApprovalDate, input.ActualPaymentDate, user.ID, input.IDs)
	if err != nil {
		fail(w, 400, "Не удалось обновить строки: "+err.Error())
		return
	}
	count, _ := result.RowsAffected()
	after, err := snapshotRows(r.Context(), tx, "obligations", input.IDs)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "bulk_update", fmt.Sprintf("Массовое изменение: %d записей", count), undoPayload{Obligations: &undoChange{Before: before, After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить массовое изменение")
		return
	}
	a.audit(r.Context(), user.ID, "bulk_update", "obligation", nil, map[string]any{"count": count})
	writeJSON(w, 200, map[string]any{"updated": count})
}

func (a *app) getObligation(ctxQuery string, args ...any) (obligation, error) {
	row := a.db.QueryRow(ctxQuery, args...)
	return scanObligation(row)
}

var _ = sql.ErrNoRows
var _ = time.Now

