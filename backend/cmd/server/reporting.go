package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *app) listReferences(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,kind,value,sort_order FROM reference_values WHERE active ORDER BY kind,sort_order,value`)
	if err != nil {
		fail(w, 500, "Не удалось загрузить справочники")
		return
	}
	defer rows.Close()
	result := map[string][]map[string]any{}
	for rows.Next() {
		var id int64
		var kind, value string
		var order int
		if err := rows.Scan(&id, &kind, &value, &order); err != nil {
			fail(w, 500, "Ошибка справочников")
			return
		}
		result[kind] = append(result[kind], map[string]any{"id": id, "value": value, "sort_order": order})
	}
	writeJSON(w, 200, result)
}

func (a *app) addReference(w http.ResponseWriter, r *http.Request) {
	kind := normalizeReferenceKind(r.PathValue("kind"))
	if kind == "" {
		fail(w, 400, "Неизвестный справочник")
		return
	}
	var input struct {
		Value string `json:"value"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Value = strings.TrimSpace(input.Value)
	if input.Value == "" {
		fail(w, 400, "Пустое значение")
		return
	}
	var id int64
	err := a.db.QueryRowContext(r.Context(), `INSERT INTO reference_values(kind,value,sort_order) VALUES($1,$2,(SELECT COALESCE(max(sort_order),-1)+1 FROM reference_values WHERE kind=$1)) ON CONFLICT(kind,value) DO UPDATE SET active=true RETURNING id`, kind, input.Value).Scan(&id)
	if err != nil {
		fail(w, 400, "Не удалось добавить значение")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "create", "reference", &id, map[string]any{"kind": kind, "value": input.Value})
	writeJSON(w, 201, map[string]any{"id": id})
}

func (a *app) deleteReference(w http.ResponseWriter, r *http.Request) {
	kind := normalizeReferenceKind(r.PathValue("kind"))
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if kind == "" || err != nil {
		fail(w, 400, "Некорректные данные")
		return
	}
	result, err := a.db.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE id=$1 AND kind=$2`, id, kind)
	if err != nil {
		fail(w, 500, "Не удалось удалить значение")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		fail(w, 404, "Значение не найдено")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "delete", "reference", &id, map[string]any{"kind": kind})
	w.WriteHeader(204)
}

func (a *app) dashboard(w http.ResponseWriter, r *http.Request) {
	asOf := r.URL.Query().Get("as_of")
	if asOf == "" {
		asOf = time.Now().Format("2006-01-02")
	}
	var totals struct {
		Count         int     `json:"count"`
		Amount        float64 `json:"amount"`
		OverdueCount  int     `json:"overdue_count"`
		OverdueAmount float64 `json:"overdue_amount"`
		DueSoonCount  int     `json:"due_soon_count"`
		DueSoonAmount float64 `json:"due_soon_amount"`
	}
	err := a.db.QueryRowContext(r.Context(), `SELECT count(*),COALESCE(sum(amount),0)::float8,count(*) FILTER(WHERE planned_payment_date<$1::date AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),COALESCE(sum(amount) FILTER(WHERE planned_payment_date<$1::date AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),0)::float8,count(*) FILTER(WHERE planned_payment_date BETWEEN $1::date AND $1::date+3 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),COALESCE(sum(amount) FILTER(WHERE planned_payment_date BETWEEN $1::date AND $1::date+3 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено')),0)::float8 FROM obligations`, asOf).Scan(&totals.Count, &totals.Amount, &totals.OverdueCount, &totals.OverdueAmount, &totals.DueSoonCount, &totals.DueSoonAmount)
	if err != nil {
		fail(w, 500, "Не удалось рассчитать сводку")
		return
	}
	statusRows, _ := a.db.QueryContext(r.Context(), `SELECT COALESCE(status,'Не указан'),count(*),COALESCE(sum(amount),0)::float8 FROM obligations GROUP BY status ORDER BY 3 DESC`)
	statuses := readGroups(statusRows)
	categoryRows, _ := a.db.QueryContext(r.Context(), `SELECT COALESCE(cost_category,'Не указана'),count(*),COALESCE(sum(amount),0)::float8 FROM obligations GROUP BY cost_category ORDER BY 3 DESC`)
	categories := readGroups(categoryRows)
	entityRows, _ := a.db.QueryContext(r.Context(), `SELECT COALESCE(legal_entity,'Не указано'),count(*),COALESCE(sum(amount),0)::float8 FROM obligations GROUP BY legal_entity ORDER BY 3 DESC`)
	entities := readGroups(entityRows)
	monthRows, _ := a.db.QueryContext(r.Context(), `SELECT to_char(date_trunc('month',planned_payment_date),'YYYY-MM'),count(*),COALESCE(sum(amount),0)::float8 FROM obligations WHERE planned_payment_date >= date_trunc('month',$1::date)-interval '3 months' AND planned_payment_date < date_trunc('month',$1::date)+interval '9 months' GROUP BY 1 ORDER BY 1`, asOf)
	months := readGroups(monthRows)
	writeJSON(w, 200, map[string]any{"as_of": asOf, "totals": totals, "by_status": statuses, "by_category": categories, "by_entity": entities, "by_month": months})
}

func readGroups(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
}) []map[string]any {
	result := []map[string]any{}
	if rows == nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var label string
		var count int
		var amount float64
		if rows.Scan(&label, &count, &amount) == nil {
			result = append(result, map[string]any{"label": label, "count": count, "amount": amount})
		}
	}
	return result
}

func (a *app) paymentRegister(w http.ResponseWriter, r *http.Request) {
	where, args := buildFilters(r, 1)
	if r.URL.Query().Get("status") == "" {
		where += " AND status='К оплате'"
	}
	rows, err := a.db.QueryContext(r.Context(), "SELECT "+obligationColumns+" FROM obligations WHERE "+where+" ORDER BY urgency DESC,planned_payment_date,id", args...)
	if err != nil {
		fail(w, 500, "Не удалось сформировать реестр к оплате")
		return
	}
	defer rows.Close()
	items := []obligation{}
	var total float64
	for rows.Next() {
		item, err := scanObligation(rows)
		if err != nil {
			fail(w, 500, "Ошибка данных")
			return
		}
		items = append(items, item)
		if item.Amount != nil {
			total += *item.Amount
		}
	}
	writeJSON(w, 200, map[string]any{"items": items, "count": len(items), "amount": total})
}

func (a *app) getSavedView(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	var raw []byte
	err := a.db.QueryRowContext(r.Context(), `SELECT filters FROM saved_views WHERE user_id=$1`, user.ID).Scan(&raw)
	if err != nil {
		writeJSON(w, 200, map[string]any{})
		return
	}
	var value any
	_ = json.Unmarshal(raw, &value)
	writeJSON(w, 200, value)
}
func (a *app) saveView(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	var value map[string]any
	if !decodeJSON(w, r, &value) {
		return
	}
	raw, _ := json.Marshal(value)
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO saved_views(user_id,filters,updated_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET filters=$2,updated_at=now()`, user.ID, raw)
	if err != nil {
		fail(w, 500, "Не удалось сохранить фильтры")
		return
	}
	writeJSON(w, 200, value)
}
