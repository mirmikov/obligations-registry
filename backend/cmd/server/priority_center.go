package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type priorityCenterSummary struct {
	Count         int     `json:"count"`
	Amount        float64 `json:"amount"`
	OverdueCount  int     `json:"overdue_count"`
	OverdueAmount float64 `json:"overdue_amount"`
	TodayCount    int     `json:"today_count"`
	TodayAmount   float64 `json:"today_amount"`
	WeekCount     int     `json:"week_count"`
	WeekAmount    float64 `json:"week_amount"`
}

type priorityCenterItem struct {
	ID                 int64    `json:"id"`
	Counterparty       string   `json:"counterparty"`
	LegalEntity        string   `json:"legal_entity"`
	CostCategory       string   `json:"cost_category"`
	Urgency            string   `json:"urgency"`
	Priority           string   `json:"priority"`
	Responsible        string   `json:"responsible"`
	DocumentNumber     string   `json:"document_number"`
	DocumentDate       string   `json:"document_date"`
	PlannedPaymentDate string   `json:"planned_payment_date"`
	Amount             *float64 `json:"amount"`
	Status             string   `json:"status"`
	ApprovalDate       string   `json:"approval_date"`
	Comment            string   `json:"comment"`
	Overdue            bool     `json:"overdue"`
	DueToday           bool     `json:"due_today"`
}

func buildPriorityCenterFilters(query url.Values) (string, []any) {
	clauses := []string{"1=1"}
	args := []any{}
	add := func(sqlPart string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(sqlPart, len(args)))
	}
	for _, filter := range []struct{ param, column string }{
		{"legal_entity", "legal_entity"}, {"responsible", "responsible"},
	} {
		if value := strings.TrimSpace(query.Get(filter.param)); value != "" {
			add(filter.column+"=$%d", value)
		}
	}
	for _, filter := range []struct{ param, column string }{
		{"urgency", "urgency"}, {"priority", "priority"},
	} {
		value := strings.TrimSpace(query.Get(filter.param))
		if value == blankAccountTypeFilter {
			clauses = append(clauses, "NULLIF(BTRIM("+filter.column+"),'') IS NULL")
		} else if value != "" {
			add(filter.column+"=$%d", value)
		}
	}
	if value := strings.TrimSpace(query.Get("q")); value != "" {
		add(`concat_ws(' ',counterparty,document_number,comment,responsible,legal_entity,cost_category) ILIKE '%%'||$%d||'%%'`, value)
	}
	switch strings.TrimSpace(query.Get("status")) {
	case "all":
		clauses = append(clauses, "COALESCE(BTRIM(status),'') NOT IN ('Оплачено','Отменено')")
	case "payable":
		clauses = append(clauses, "BTRIM(COALESCE(status,''))='К оплате'")
	default:
		clauses = append(clauses, "BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано')")
	}
	switch strings.TrimSpace(query.Get("scope")) {
	case "overdue":
		clauses = append(clauses, "planned_payment_date<CURRENT_DATE")
	case "today":
		clauses = append(clauses, "planned_payment_date<=CURRENT_DATE")
	case "week":
		clauses = append(clauses, "planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+6")
	case "all":
	default:
		clauses = append(clauses, `(planned_payment_date<=CURRENT_DATE+6
			OR lower(COALESCE(urgency,'')) ~ '(крит|сроч|высок)'
			OR lower(COALESCE(priority,'')) ~ '(крит|сроч|высок|важ)')`)
	}
	return strings.Join(clauses, " AND "), args
}

func (a *app) priorityCenter(w http.ResponseWriter, r *http.Request) {
	where, args := buildPriorityCenterFilters(r.URL.Query())
	var summary priorityCenterSummary
	summaryQuery := `SELECT count(*),COALESCE(sum(amount),0)::float8,
		count(*) FILTER(WHERE planned_payment_date<CURRENT_DATE),
		COALESCE(sum(amount) FILTER(WHERE planned_payment_date<CURRENT_DATE),0)::float8,
		count(*) FILTER(WHERE planned_payment_date=CURRENT_DATE),
		COALESCE(sum(amount) FILTER(WHERE planned_payment_date=CURRENT_DATE),0)::float8,
		count(*) FILTER(WHERE planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+6),
		COALESCE(sum(amount) FILTER(WHERE planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+6),0)::float8
		FROM obligations WHERE ` + where
	if err := a.db.QueryRowContext(r.Context(), summaryQuery, args...).Scan(&summary.Count, &summary.Amount, &summary.OverdueCount, &summary.OverdueAmount, &summary.TodayCount, &summary.TodayAmount, &summary.WeekCount, &summary.WeekAmount); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось рассчитать очередь срочных платежей")
		return
	}

	rows, err := a.db.QueryContext(r.Context(), `SELECT id,COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(cost_category,''),COALESCE(urgency,''),COALESCE(priority,''),COALESCE(responsible,''),COALESCE(document_number,''),COALESCE(to_char(document_date,'YYYY-MM-DD'),''),COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),amount::float8,COALESCE(status,''),COALESCE(to_char(approval_date,'YYYY-MM-DD'),''),COALESCE(comment,''),COALESCE(planned_payment_date<CURRENT_DATE,false),COALESCE(planned_payment_date=CURRENT_DATE,false)
		FROM obligations WHERE `+where+`
		ORDER BY (planned_payment_date<CURRENT_DATE) DESC,
			CASE WHEN lower(COALESCE(urgency,'')) ~ '(крит|сроч)' THEN 0 WHEN lower(COALESCE(urgency,'')) LIKE '%высок%' THEN 1 WHEN NULLIF(BTRIM(urgency),'') IS NULL THEN 4 ELSE 2 END,
			CASE WHEN lower(COALESCE(priority,'')) ~ '(крит|сроч|высок)' THEN 0 WHEN lower(COALESCE(priority,'')) LIKE '%важ%' THEN 1 WHEN NULLIF(BTRIM(priority),'') IS NULL THEN 4 ELSE 2 END,
			planned_payment_date NULLS LAST,amount DESC NULLS LAST,id DESC LIMIT 300`, args...)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить очередь срочных платежей")
		return
	}
	defer rows.Close()
	items := []priorityCenterItem{}
	for rows.Next() {
		var item priorityCenterItem
		if err = rows.Scan(&item.ID, &item.Counterparty, &item.LegalEntity, &item.CostCategory, &item.Urgency, &item.Priority, &item.Responsible, &item.DocumentNumber, &item.DocumentDate, &item.PlannedPaymentDate, &item.Amount, &item.Status, &item.ApprovalDate, &item.Comment, &item.Overdue, &item.DueToday); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка данных очереди срочных платежей")
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка чтения очереди срочных платежей")
		return
	}
	options := map[string][]string{}
	for key, column := range map[string]string{"legal_entities": "legal_entity", "responsibles": "responsible", "urgencies": "urgency", "priorities": "priority"} {
		values, optionErr := a.priorityCenterOptions(r, column)
		if optionErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось загрузить фильтры срочных платежей")
			return
		}
		options[key] = values
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "items": items, "options": options})
}

func (a *app) approvePriorityCenter(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs          []int64 `json:"ids"`
		ApprovalDate string  `json:"approval_date"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	ids := uniquePositiveIDs(input.IDs)
	if len(ids) == 0 || len(ids) > 200 {
		fail(w, http.StatusBadRequest, "Выберите от 1 до 200 платежей")
		return
	}
	input.ApprovalDate = strings.TrimSpace(input.ApprovalDate)
	if input.ApprovalDate == "" {
		input.ApprovalDate = time.Now().Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", input.ApprovalDate); err != nil {
		fail(w, http.StatusBadRequest, "Укажите корректную дату утверждения")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать согласование")
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), `SELECT id,COALESCE(legal_entity,'') FROM obligations WHERE id=ANY($1) AND BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано') AND actual_payment_date IS NULL ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить платежи к согласованию")
		return
	}
	eligible := []int64{}
	for rows.Next() {
		var id int64
		var legalEntity string
		if err = rows.Scan(&id, &legalEntity); err != nil {
			rows.Close()
			fail(w, http.StatusInternalServerError, "Не удалось проверить платежи")
			return
		}
		if !canApproveLegalEntity(user, legalEntity) {
			rows.Close()
			fail(w, http.StatusForbidden, approvalLegalEntityError{LegalEntity: legalEntity}.Error())
			return
		}
		eligible = append(eligible, id)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось проверить платежи")
		return
	}
	if err = rows.Close(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить платежи")
		return
	}
	if len(eligible) == 0 {
		fail(w, http.StatusConflict, "Выбранные платежи уже согласованы или недоступны")
		return
	}
	before, err := snapshotRows(r.Context(), tx, "obligations", eligible)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю согласования")
		return
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE obligations SET approval_date=$1::date,status=$2,updated_by=$3,updated_at=now() WHERE id=ANY($4)`, input.ApprovalDate, payableStatus, user.ID, eligible)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось согласовать платежи")
		return
	}
	updated, _ := result.RowsAffected()
	after, err := snapshotRows(r.Context(), tx, "obligations", eligible)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "priority_approve", fmt.Sprintf("Согласование срочных платежей: %d", updated), undoPayload{Obligations: &undoChange{Before: before, After: after}}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю согласования")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить согласование")
		return
	}
	a.audit(r.Context(), user.ID, "approve", "obligations", nil, map[string]any{"ids": eligible, "approval_date": input.ApprovalDate, "status": payableStatus})
	writeJSON(w, http.StatusOK, map[string]any{"updated": updated, "skipped": len(ids) - len(eligible), "approval_date": input.ApprovalDate, "status": payableStatus})
}

func uniquePositiveIDs(values []int64) []int64 {
	seen := map[int64]bool{}
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value > 0 && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func (a *app) priorityCenterOptions(r *http.Request, column string) ([]string, error) {
	allowed := map[string]bool{"legal_entity": true, "responsible": true, "urgency": true, "priority": true}
	if !allowed[column] {
		return nil, fmt.Errorf("unsupported option column")
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT DISTINCT BTRIM(`+column+`) FROM obligations WHERE NULLIF(BTRIM(`+column+`),'') IS NOT NULL ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []string{}
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}
