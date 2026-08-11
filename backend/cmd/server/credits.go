package main

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

const creditsLeasingCategory = "Кредиты и лизинг"

type creditsLeasingTotals struct {
	Count             int     `json:"count"`
	TotalAmount       float64 `json:"total_amount"`
	PaidAmount        float64 `json:"paid_amount"`
	OutstandingAmount float64 `json:"outstanding_amount"`
	OverdueCount      int     `json:"overdue_count"`
	OverdueAmount     float64 `json:"overdue_amount"`
	Next30Amount      float64 `json:"next_30_amount"`
}

type creditsLeasingEntity struct {
	Name   string  `json:"name"`
	Count  int     `json:"count"`
	Amount float64 `json:"amount"`
}

type creditsLeasingCreditor struct {
	Name              string  `json:"name"`
	Count             int     `json:"count"`
	TotalAmount       float64 `json:"total_amount"`
	PaidAmount        float64 `json:"paid_amount"`
	OutstandingAmount float64 `json:"outstanding_amount"`
}

type creditsLeasingMonth struct {
	Month             string  `json:"month"`
	TotalAmount       float64 `json:"total_amount"`
	PaidAmount        float64 `json:"paid_amount"`
	OutstandingAmount float64 `json:"outstanding_amount"`
}

type creditsLeasingPayment struct {
	Date              string  `json:"date"`
	Counterparty      string  `json:"counterparty"`
	Count             int     `json:"count"`
	TotalAmount       float64 `json:"total_amount"`
	PaidAmount        float64 `json:"paid_amount"`
	OutstandingAmount float64 `json:"outstanding_amount"`
	Overdue           bool    `json:"overdue"`
}

func (a *app) creditsLeasingReport(w http.ResponseWriter, r *http.Request) {
	asOf := r.URL.Query().Get("as_of")
	if _, err := time.Parse("2006-01-02", asOf); asOf == "" || err != nil {
		asOf = time.Now().Format("2006-01-02")
	}

	entityRows, err := a.db.QueryContext(r.Context(), `
		SELECT COALESCE(legal_entity,'Не указано'),count(*),COALESCE(sum(amount),0)::float8
		FROM obligations
		WHERE cost_category=$1
		GROUP BY legal_entity
		ORDER BY sum(amount) DESC,legal_entity`, creditsLeasingCategory)
	if err != nil {
		fail(w, 500, "Не удалось сформировать список юрлиц")
		return
	}
	entities := []creditsLeasingEntity{}
	for entityRows.Next() {
		var item creditsLeasingEntity
		if err := entityRows.Scan(&item.Name, &item.Count, &item.Amount); err != nil {
			entityRows.Close()
			fail(w, 500, "Ошибка данных по юрлицам")
			return
		}
		entities = append(entities, item)
	}
	entityRows.Close()

	selectedEntity := r.URL.Query().Get("legal_entity")
	if selectedEntity == "" && len(entities) > 0 {
		selectedEntity = entities[0].Name
	}
	validEntity := false
	for _, entity := range entities {
		if entity.Name == selectedEntity {
			validEntity = true
			break
		}
	}
	if !validEntity && len(entities) > 0 {
		selectedEntity = entities[0].Name
	}

	var totals creditsLeasingTotals
	err = a.db.QueryRowContext(r.Context(), `
		SELECT count(*),COALESCE(sum(amount),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE status='Оплачено' OR actual_payment_date IS NOT NULL),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8,
			count(*) FILTER (WHERE planned_payment_date<$3::date AND COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),
			COALESCE(sum(amount) FILTER (WHERE planned_payment_date<$3::date AND COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE planned_payment_date BETWEEN $3::date AND $3::date+30 AND COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8
		FROM obligations WHERE cost_category=$1 AND COALESCE(legal_entity,'Не указано')=$2`, creditsLeasingCategory, selectedEntity, asOf).Scan(
		&totals.Count, &totals.TotalAmount, &totals.PaidAmount, &totals.OutstandingAmount, &totals.OverdueCount, &totals.OverdueAmount, &totals.Next30Amount,
	)
	if err != nil {
		fail(w, 500, "Не удалось рассчитать показатели отчёта")
		return
	}

	creditorRows, err := a.db.QueryContext(r.Context(), `
		SELECT COALESCE(counterparty,'Не указан'),count(*),COALESCE(sum(amount),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE status='Оплачено' OR actual_payment_date IS NOT NULL),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8
		FROM obligations WHERE cost_category=$1 AND COALESCE(legal_entity,'Не указано')=$2
		GROUP BY counterparty ORDER BY sum(amount) DESC,counterparty`, creditsLeasingCategory, selectedEntity)
	if err != nil {
		fail(w, 500, "Не удалось рассчитать кредиторов")
		return
	}
	creditors := []creditsLeasingCreditor{}
	for creditorRows.Next() {
		var item creditsLeasingCreditor
		if err := creditorRows.Scan(&item.Name, &item.Count, &item.TotalAmount, &item.PaidAmount, &item.OutstandingAmount); err != nil {
			creditorRows.Close()
			fail(w, 500, "Ошибка данных по кредиторам")
			return
		}
		creditors = append(creditors, item)
	}
	creditorRows.Close()

	monthRows, err := a.db.QueryContext(r.Context(), `
		SELECT to_char(date_trunc('month',planned_payment_date),'YYYY-MM'),COALESCE(sum(amount),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE status='Оплачено' OR actual_payment_date IS NOT NULL),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8
		FROM obligations WHERE cost_category=$1 AND COALESCE(legal_entity,'Не указано')=$2 AND planned_payment_date IS NOT NULL
		GROUP BY 1 ORDER BY 1`, creditsLeasingCategory, selectedEntity)
	if err != nil {
		fail(w, 500, "Не удалось рассчитать платёжную нагрузку")
		return
	}
	months := []creditsLeasingMonth{}
	for monthRows.Next() {
		var item creditsLeasingMonth
		if err := monthRows.Scan(&item.Month, &item.TotalAmount, &item.PaidAmount, &item.OutstandingAmount); err != nil {
			monthRows.Close()
			fail(w, 500, "Ошибка помесячных данных")
			return
		}
		months = append(months, item)
	}
	monthRows.Close()

	paymentRows, err := a.db.QueryContext(r.Context(), `
		SELECT to_char(planned_payment_date,'YYYY-MM-DD'),COALESCE(counterparty,'Не указан'),count(*),COALESCE(sum(amount),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE status='Оплачено' OR actual_payment_date IS NOT NULL),0)::float8,
			COALESCE(sum(amount) FILTER (WHERE COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL),0)::float8,
			planned_payment_date<$3::date AND bool_or(COALESCE(status,'') NOT IN ('Оплачено','Отменено') AND actual_payment_date IS NULL)
		FROM obligations WHERE cost_category=$1 AND COALESCE(legal_entity,'Не указано')=$2 AND planned_payment_date IS NOT NULL
		GROUP BY planned_payment_date,counterparty ORDER BY planned_payment_date,counterparty`, creditsLeasingCategory, selectedEntity, asOf)
	if err != nil {
		fail(w, 500, "Не удалось сформировать график платежей")
		return
	}
	payments := []creditsLeasingPayment{}
	for paymentRows.Next() {
		var item creditsLeasingPayment
		if err := paymentRows.Scan(&item.Date, &item.Counterparty, &item.Count, &item.TotalAmount, &item.PaidAmount, &item.OutstandingAmount, &item.Overdue); err != nil {
			paymentRows.Close()
			fail(w, 500, "Ошибка графика платежей")
			return
		}
		payments = append(payments, item)
	}
	paymentRows.Close()

	writeJSON(w, 200, map[string]any{
		"category": creditsLeasingCategory, "as_of": asOf, "selected_entity": selectedEntity,
		"entities": entities, "totals": totals, "creditors": creditors, "months": months, "payments": payments,
	})
}

func (a *app) creditsLeasingDetails(w http.ResponseWriter, r *http.Request) {
	paymentDate := strings.TrimSpace(r.URL.Query().Get("date"))
	if _, err := time.Parse("2006-01-02", paymentDate); err != nil {
		fail(w, http.StatusBadRequest, "Некорректная дата платежа")
		return
	}
	legalEntity := strings.TrimSpace(r.URL.Query().Get("legal_entity"))
	if legalEntity == "" {
		fail(w, http.StatusBadRequest, "Не указано юридическое лицо")
		return
	}
	counterparties := []string{}
	seenCounterparties := map[string]bool{}
	for _, raw := range r.URL.Query()["counterparty"] {
		counterparty := strings.TrimSpace(raw)
		if counterparty != "" && !seenCounterparties[counterparty] {
			counterparties = append(counterparties, counterparty)
			seenCounterparties[counterparty] = true
		}
	}
	args := []any{creditsLeasingCategory, legalEntity, paymentDate}
	where := "cost_category=$1 AND COALESCE(legal_entity,'Не указано')=$2 AND planned_payment_date=$3::date"
	if len(counterparties) > 0 {
		args = append(args, counterparties)
		where += fmt.Sprintf(" AND COALESCE(counterparty,'Не указан')=ANY($%d::text[])", len(args))
	}

	rows, err := a.db.QueryContext(r.Context(), fmt.Sprintf(`
		SELECT %s FROM obligations
		WHERE %s
		ORDER BY counterparty,document_date,document_number,id`, obligationColumns, where), args...)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить платежи выбранного дня")
		return
	}
	defer rows.Close()

	items := []obligation{}
	var totalAmount, paidAmount, outstandingAmount float64
	for rows.Next() {
		item, scanErr := scanObligation(rows)
		if scanErr != nil {
			log.Printf("scan credits leasing detail: %v", scanErr)
			fail(w, http.StatusInternalServerError, "Ошибка данных платежей выбранного дня")
			return
		}
		amount := 0.0
		if item.Amount != nil {
			amount = *item.Amount
		}
		totalAmount += amount
		if item.Status == "Оплачено" || item.ActualPaymentDate != "" {
			paidAmount += amount
		} else if item.Status != "Отменено" {
			outstandingAmount += amount
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка данных платежей выбранного дня")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"date": paymentDate, "legal_entity": legalEntity, "counterparties": counterparties,
		"count": len(items), "amount": totalAmount, "paid_amount": paidAmount,
		"outstanding_amount": outstandingAmount, "items": items,
	})
}
