package main

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
)

type priorityCenterSummary struct {
	Count              int     `json:"count"`
	Amount             float64 `json:"amount"`
	OverdueCount       int     `json:"overdue_count"`
	OverdueAmount      float64 `json:"overdue_amount"`
	WeekCount          int     `json:"week_count"`
	WeekAmount         float64 `json:"week_amount"`
	UnclassifiedCount  int     `json:"unclassified_count"`
	UnclassifiedAmount float64 `json:"unclassified_amount"`
}

type priorityCenterCell struct {
	Urgency      string  `json:"urgency"`
	Priority     string  `json:"priority"`
	Count        int     `json:"count"`
	Amount       float64 `json:"amount"`
	OverdueCount int     `json:"overdue_count"`
	EarliestDue  string  `json:"earliest_due"`
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
}

func buildPriorityCenterFilters(query url.Values) (string, []any) {
	clauses := []string{"1=1"}
	args := []any{}
	add := func(sqlPart string, value any) {
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(sqlPart, len(args)))
	}
	for _, filter := range []struct{ param, column string }{
		{"legal_entity", "legal_entity"}, {"responsible", "responsible"}, {"status", "status"},
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
	switch query.Get("scope") {
	case "all":
	case "overdue":
		clauses = append(clauses, "planned_payment_date<CURRENT_DATE", "COALESCE(status,'') NOT IN ('Оплачено','Отменено')")
	case "week":
		clauses = append(clauses, "planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7", "COALESCE(status,'') NOT IN ('Оплачено','Отменено')")
	default:
		clauses = append(clauses, "COALESCE(status,'') NOT IN ('Оплачено','Отменено')")
	}
	return strings.Join(clauses, " AND "), args
}

func (a *app) priorityCenter(w http.ResponseWriter, r *http.Request) {
	where, args := buildPriorityCenterFilters(r.URL.Query())
	var summary priorityCenterSummary
	summaryQuery := `SELECT count(*),COALESCE(sum(amount),0)::float8,
		count(*) FILTER(WHERE planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),
		COALESCE(sum(amount) FILTER(WHERE planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),0)::float8,
		count(*) FILTER(WHERE planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),
		COALESCE(sum(amount) FILTER(WHERE planned_payment_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),0)::float8,
		count(*) FILTER(WHERE NULLIF(BTRIM(urgency),'') IS NULL OR NULLIF(BTRIM(priority),'') IS NULL),
		COALESCE(sum(amount) FILTER(WHERE NULLIF(BTRIM(urgency),'') IS NULL OR NULLIF(BTRIM(priority),'') IS NULL),0)::float8
		FROM obligations WHERE ` + where
	if err := a.db.QueryRowContext(r.Context(), summaryQuery, args...).Scan(&summary.Count, &summary.Amount, &summary.OverdueCount, &summary.OverdueAmount, &summary.WeekCount, &summary.WeekAmount, &summary.UnclassifiedCount, &summary.UnclassifiedAmount); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось рассчитать центр приоритетов")
		return
	}

	matrixRows, err := a.db.QueryContext(r.Context(), `SELECT COALESCE(NULLIF(BTRIM(urgency),''),'—'),COALESCE(NULLIF(BTRIM(priority),''),'—'),count(*),COALESCE(sum(amount),0)::float8,count(*) FILTER(WHERE planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),COALESCE(to_char(min(planned_payment_date),'YYYY-MM-DD'),'') FROM obligations WHERE `+where+` GROUP BY 1,2 ORDER BY count(*) DESC,1,2`, args...)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось построить матрицу приоритетов")
		return
	}
	defer matrixRows.Close()
	matrix := []priorityCenterCell{}
	for matrixRows.Next() {
		var item priorityCenterCell
		if err = matrixRows.Scan(&item.Urgency, &item.Priority, &item.Count, &item.Amount, &item.OverdueCount, &item.EarliestDue); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка данных матрицы приоритетов")
			return
		}
		matrix = append(matrix, item)
	}
	if err = matrixRows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка чтения матрицы приоритетов")
		return
	}

	itemRows, err := a.db.QueryContext(r.Context(), `SELECT id,COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(cost_category,''),COALESCE(urgency,''),COALESCE(priority,''),COALESCE(responsible,''),COALESCE(document_number,''),COALESCE(to_char(document_date,'YYYY-MM-DD'),''),COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),amount::float8,COALESCE(status,''),COALESCE(to_char(approval_date,'YYYY-MM-DD'),''),COALESCE(comment,''),COALESCE(planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено'),false) FROM obligations WHERE `+where+` ORDER BY (planned_payment_date<CURRENT_DATE AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')) DESC,planned_payment_date NULLS LAST,id DESC LIMIT 300`, args...)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить обязательства по приоритетам")
		return
	}
	defer itemRows.Close()
	items := []priorityCenterItem{}
	for itemRows.Next() {
		var item priorityCenterItem
		if err = itemRows.Scan(&item.ID, &item.Counterparty, &item.LegalEntity, &item.CostCategory, &item.Urgency, &item.Priority, &item.Responsible, &item.DocumentNumber, &item.DocumentDate, &item.PlannedPaymentDate, &item.Amount, &item.Status, &item.ApprovalDate, &item.Comment, &item.Overdue); err != nil {
			log.Printf("priority center row: %v", err)
			fail(w, http.StatusInternalServerError, "Ошибка данных центра приоритетов")
			return
		}
		items = append(items, item)
	}
	if err = itemRows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка чтения центра приоритетов")
		return
	}
	options := map[string][]string{}
	for key, column := range map[string]string{"legal_entities": "legal_entity", "responsibles": "responsible", "statuses": "status", "urgencies": "urgency", "priorities": "priority"} {
		values, optionErr := a.priorityCenterOptions(r, column)
		if optionErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось загрузить фильтры центра приоритетов")
			return
		}
		options[key] = values
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "matrix": matrix, "items": items, "options": options})
}

func (a *app) priorityCenterOptions(r *http.Request, column string) ([]string, error) {
	allowed := map[string]bool{"legal_entity": true, "responsible": true, "status": true, "urgency": true, "priority": true}
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
