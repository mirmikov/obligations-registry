package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	executiveRegisteredStatus = "Зарегистрирован"
	executivePayableStatus    = "К оплате"
	executiveStatusFilterSQL  = `(
		($4='Зарегистрирован' AND BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано'))
		OR ($4='К оплате' AND BTRIM(COALESCE(status,''))='К оплате')
	)`
)

type executiveFilters struct {
	AsOf        string `json:"as_of"`
	LegalEntity string `json:"legal_entity"`
	AccountType string `json:"account_type"`
	Status      string `json:"status"`
}

type executiveGroup struct {
	CostCategory string  `json:"cost_category"`
	Count        int     `json:"count"`
	Amount       float64 `json:"amount"`
}

type executivePeriod struct {
	Key    string           `json:"key"`
	Title  string           `json:"title"`
	From   string           `json:"from,omitempty"`
	To     string           `json:"to"`
	Count  int              `json:"count"`
	Amount float64          `json:"amount"`
	Groups []executiveGroup `json:"groups"`
}

type executiveDetail struct {
	ID                 int64   `json:"id"`
	LegalEntity        string  `json:"legal_entity"`
	PlannedPaymentDate string  `json:"planned_payment_date"`
	Counterparty       string  `json:"counterparty"`
	PaymentPurpose     string  `json:"payment_purpose"`
	Comment            string  `json:"comment"`
	Amount             float64 `json:"amount"`
	Responsible        string  `json:"responsible"`
	Status             string  `json:"status"`
	ApprovalDate       string  `json:"approval_date"`
}

func parseExecutiveFilters(r *http.Request) (executiveFilters, time.Time, error) {
	asOf := strings.TrimSpace(r.URL.Query().Get("as_of"))
	if asOf == "" {
		asOf = time.Now().Format("2006-01-02")
	}
	reportDate, err := time.Parse("2006-01-02", asOf)
	if err != nil {
		return executiveFilters{}, time.Time{}, fmt.Errorf("некорректная дата отчёта")
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "" {
		status = executiveRegisteredStatus
	}
	if status != executiveRegisteredStatus && status != executivePayableStatus {
		return executiveFilters{}, time.Time{}, fmt.Errorf("некорректный статус отчёта")
	}
	return executiveFilters{
		AsOf:        asOf,
		LegalEntity: strings.TrimSpace(r.URL.Query().Get("legal_entity")),
		AccountType: strings.TrimSpace(r.URL.Query().Get("account_type")),
		Status:      status,
	}, reportDate, nil
}

func executivePeriodDefinition(key string, reportDate time.Time) (executivePeriod, string, bool) {
	date := reportDate.Format("2006-01-02")
	switch key {
	case "overdue":
		return executivePeriod{
			Key: "overdue", Title: "Просроченные обязательства",
			To: reportDate.AddDate(0, 0, -1).Format("2006-01-02"),
		}, "planned_payment_date < $1::date", true
	case "week":
		daysToSunday := (7 - int(reportDate.Weekday())) % 7
		return executivePeriod{
			Key: "week", Title: "Обязательства до конца недели",
			From: date, To: reportDate.AddDate(0, 0, daysToSunday).Format("2006-01-02"),
		}, "planned_payment_date BETWEEN $1::date AND (date_trunc('week',$1::date)::date + 6)", true
	case "month":
		lastDay := time.Date(reportDate.Year(), reportDate.Month()+1, 0, 0, 0, 0, 0, reportDate.Location())
		return executivePeriod{
			Key: "month", Title: "Обязательства до конца месяца",
			From: date, To: lastDay.Format("2006-01-02"),
		}, "planned_payment_date BETWEEN $1::date AND (date_trunc('month',$1::date)::date + interval '1 month - 1 day')::date", true
	default:
		return executivePeriod{}, "", false
	}
}

func executiveBaseFilter(periodClause string) string {
	return `planned_payment_date IS NOT NULL
		AND ` + periodClause + `
		AND ($2='' OR legal_entity=$2)
		AND (
			$3=''
			OR ($3='` + blankAccountTypeFilter + `' AND NULLIF(BTRIM(account_type),'') IS NULL)
			OR account_type=$3
		)
		AND ` + executiveStatusFilterSQL
}

func (a *app) executiveDashboard(w http.ResponseWriter, r *http.Request) {
	filters, reportDate, err := parseExecutiveFilters(r)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	periods := make([]executivePeriod, 0, 3)
	for _, key := range []string{"overdue", "week", "month"} {
		period, clause, _ := executivePeriodDefinition(key, reportDate)
		rows, queryErr := a.db.QueryContext(r.Context(), `
			SELECT COALESCE(NULLIF(BTRIM(cost_category),''),'Без статьи затрат'),count(*),COALESCE(sum(amount),0)::float8
			FROM obligations
			WHERE `+executiveBaseFilter(clause)+`
			GROUP BY 1
			ORDER BY 3 DESC,1`, filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status)
		if queryErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось рассчитать панель руководителя")
			return
		}
		period.Groups = []executiveGroup{}
		for rows.Next() {
			var group executiveGroup
			if scanErr := rows.Scan(&group.CostCategory, &group.Count, &group.Amount); scanErr != nil {
				rows.Close()
				fail(w, http.StatusInternalServerError, "Ошибка данных панели руководителя")
				return
			}
			period.Count += group.Count
			period.Amount += group.Amount
			period.Groups = append(period.Groups, group)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			fail(w, http.StatusInternalServerError, "Ошибка данных панели руководителя")
			return
		}
		rows.Close()
		periods = append(periods, period)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"as_of": filters.AsOf, "legal_entity": filters.LegalEntity,
		"account_type": filters.AccountType, "status": filters.Status, "periods": periods,
	})
}

func (a *app) executiveDashboardDetails(w http.ResponseWriter, r *http.Request) {
	filters, reportDate, err := parseExecutiveFilters(r)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	periodKey := strings.TrimSpace(r.URL.Query().Get("period"))
	period, clause, ok := executivePeriodDefinition(periodKey, reportDate)
	if !ok {
		fail(w, http.StatusBadRequest, "Некорректный период отчёта")
		return
	}
	category := strings.TrimSpace(r.URL.Query().Get("cost_category"))
	if category == "" {
		fail(w, http.StatusBadRequest, "Не указана статья затрат")
		return
	}

	rows, queryErr := a.db.QueryContext(r.Context(), `
		SELECT id,
			COALESCE(legal_entity,''),
			COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),
			COALESCE(counterparty,''),
			COALESCE(NULLIF(BTRIM(document_number),''),NULLIF(BTRIM(cost_category),''),''),
			COALESCE(comment,''),
			COALESCE(amount,0)::float8,
			COALESCE(responsible,''),
			COALESCE(status,''),
			COALESCE(to_char(approval_date,'YYYY-MM-DD'),'')
		FROM obligations
		WHERE `+executiveBaseFilter(clause)+`
			AND COALESCE(NULLIF(BTRIM(cost_category),''),'Без статьи затрат')=$5
		ORDER BY planned_payment_date,amount DESC,id`, filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status, category)
	if queryErr != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить детализацию")
		return
	}
	defer rows.Close()

	items := []executiveDetail{}
	var amount float64
	for rows.Next() {
		var item executiveDetail
		if scanErr := rows.Scan(
			&item.ID, &item.LegalEntity, &item.PlannedPaymentDate, &item.Counterparty,
			&item.PaymentPurpose, &item.Comment, &item.Amount, &item.Responsible,
			&item.Status, &item.ApprovalDate,
		); scanErr != nil {
			fail(w, http.StatusInternalServerError, "Ошибка данных детализации")
			return
		}
		items = append(items, item)
		amount += item.Amount
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		fail(w, http.StatusInternalServerError, "Ошибка данных детализации")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"period": period, "cost_category": category,
		"count": len(items), "amount": amount, "items": items,
	})
}
