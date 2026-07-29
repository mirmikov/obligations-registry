package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	executiveRegisteredStatus      = "Зарегистрирован"
	executivePayableStatus         = "К оплате"
	executiveSpecialSectionID      = "kibirev_rent"
	executiveSpecialTitle          = "Аренда — ИП Кибирев О. А."
	executiveSettingsReferenceKind = "__executive_setting"
	executiveSpecialMatchSQL       = `LOWER(BTRIM(COALESCE(cost_category,'')))=LOWER('Аренда')
		AND LOWER(REGEXP_REPLACE(BTRIM(COALESCE(counterparty,'')), '[[:space:]]+', '', 'g'))=
			LOWER(REGEXP_REPLACE('ИП Кибирев О. А.', '[[:space:]]+', '', 'g'))`
	executiveStatusFilterSQL = `(
		($4='' AND BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано','К оплате'))
		OR ($4='Зарегистрирован' AND BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано'))
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

type executiveSpecialSummary struct {
	ID               string  `json:"id"`
	Title            string  `json:"title"`
	Count            int     `json:"count"`
	Amount           float64 `json:"amount"`
	RegisteredCount  int     `json:"registered_count"`
	RegisteredAmount float64 `json:"registered_amount"`
	PayableCount     int     `json:"payable_count"`
	PayableAmount    float64 `json:"payable_amount"`
	From             string  `json:"from,omitempty"`
	To               string  `json:"to"`
}

type executiveSpecialDetail struct {
	ID                 int64   `json:"id"`
	LegalEntity        string  `json:"legal_entity"`
	PlannedPaymentDate string  `json:"planned_payment_date"`
	DocumentNumber     string  `json:"document_number"`
	DocumentDate       string  `json:"document_date"`
	PaymentPurpose     string  `json:"payment_purpose"`
	Comment            string  `json:"comment"`
	Amount             float64 `json:"amount"`
	PaidAmount         float64 `json:"paid_amount"`
	OutstandingAmount  float64 `json:"outstanding_amount"`
	Status             string  `json:"status"`
	ApprovalDate       string  `json:"approval_date"`
}

type executiveSettingsPayload struct {
	KibirevRentEnabled bool `json:"kibirev_rent_enabled"`
}

func (a *app) executiveSpecialEnabled(r *http.Request) (bool, error) {
	var active bool
	err := a.db.QueryRowContext(r.Context(), `
		SELECT active FROM reference_values WHERE kind=$1 AND value=$2`,
		executiveSettingsReferenceKind, executiveSpecialSectionID,
	).Scan(&active)
	if err == sql.ErrNoRows {
		return true, nil
	}
	return active, err
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
	if status != "" && status != executiveRegisteredStatus && status != executivePayableStatus {
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
		AND ` + executiveStatusFilterSQL + `
		AND (NOT $5 OR NOT (` + executiveSpecialMatchSQL + `))`
}

func executiveSpecialBaseFilter() string {
	return `planned_payment_date IS NOT NULL
		AND planned_payment_date <= (date_trunc('month',$1::date)::date + interval '1 month - 1 day')::date
		AND ($2='' OR legal_entity=$2)
		AND (
			$3=''
			OR ($3='` + blankAccountTypeFilter + `' AND NULLIF(BTRIM(account_type),'') IS NULL)
			OR account_type=$3
		)
		AND ` + executiveStatusFilterSQL + `
		AND (` + executiveSpecialMatchSQL + `)`
}

func (a *app) executiveDashboard(w http.ResponseWriter, r *http.Request) {
	filters, reportDate, err := parseExecutiveFilters(r)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	specialEnabled, err := a.executiveSpecialEnabled(r)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить настройки панели руководителя")
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
			ORDER BY 3 DESC,1`, filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status, specialEnabled)
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

	var specialSection any
	if specialEnabled {
		lastDay := time.Date(reportDate.Year(), reportDate.Month()+1, 0, 0, 0, 0, 0, reportDate.Location())
		summary := executiveSpecialSummary{
			ID: executiveSpecialSectionID, Title: executiveSpecialTitle,
			To: lastDay.Format("2006-01-02"),
		}
		queryErr := a.db.QueryRowContext(r.Context(), `
			SELECT count(*),
				COALESCE(sum(amount),0)::float8,
				count(*) FILTER (WHERE BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано')),
				COALESCE(sum(amount) FILTER (WHERE BTRIM(COALESCE(status,'')) IN ('Зарегистрирован','Зарегистрировано')),0)::float8,
				count(*) FILTER (WHERE BTRIM(COALESCE(status,''))='К оплате'),
				COALESCE(sum(amount) FILTER (WHERE BTRIM(COALESCE(status,''))='К оплате'),0)::float8
			FROM obligations
			WHERE `+executiveSpecialBaseFilter(),
			filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status,
		).Scan(&summary.Count, &summary.Amount, &summary.RegisteredCount, &summary.RegisteredAmount, &summary.PayableCount, &summary.PayableAmount)
		if queryErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось рассчитать раздел аренды")
			return
		}
		specialSection = summary
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"as_of": filters.AsOf, "legal_entity": filters.LegalEntity,
		"account_type": filters.AccountType, "status": filters.Status, "periods": periods,
		"special_section": specialSection,
	})
}

func (a *app) executiveDashboardDetails(w http.ResponseWriter, r *http.Request) {
	filters, reportDate, err := parseExecutiveFilters(r)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	specialEnabled, err := a.executiveSpecialEnabled(r)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить настройки панели руководителя")
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
			AND COALESCE(NULLIF(BTRIM(cost_category),''),'Без статьи затрат')=$6
		ORDER BY planned_payment_date,amount DESC,id`, filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status, specialEnabled, category)
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

func (a *app) executiveSpecialDetails(w http.ResponseWriter, r *http.Request) {
	filters, reportDate, err := parseExecutiveFilters(r)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	enabled, err := a.executiveSpecialEnabled(r)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить настройки панели руководителя")
		return
	}
	if !enabled {
		fail(w, http.StatusNotFound, "Специальный раздел отключён")
		return
	}

	rows, queryErr := a.db.QueryContext(r.Context(), `
		SELECT id,
			COALESCE(legal_entity,''),
			COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),
			COALESCE(document_number,''),
			COALESCE(to_char(document_date,'YYYY-MM-DD'),''),
			COALESCE(NULLIF(BTRIM(source_note),''),NULLIF(BTRIM(cost_category),''),''),
			COALESCE(comment,''),
			COALESCE(amount,0)::float8,
			CASE WHEN actual_payment_date IS NOT NULL OR BTRIM(COALESCE(status,''))='Оплачено' THEN COALESCE(amount,0) ELSE 0 END::float8,
			CASE WHEN actual_payment_date IS NULL AND BTRIM(COALESCE(status,'')) NOT IN ('Оплачено','Отменено') THEN COALESCE(amount,0) ELSE 0 END::float8,
			COALESCE(status,''),
			COALESCE(to_char(approval_date,'YYYY-MM-DD'),'')
		FROM obligations
		WHERE `+executiveSpecialBaseFilter()+`
		ORDER BY planned_payment_date,document_date,document_number,id`,
		filters.AsOf, filters.LegalEntity, filters.AccountType, filters.Status)
	if queryErr != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить счета по аренде")
		return
	}
	defer rows.Close()

	items := []executiveSpecialDetail{}
	var amount, paidAmount, outstandingAmount float64
	for rows.Next() {
		var item executiveSpecialDetail
		if scanErr := rows.Scan(
			&item.ID, &item.LegalEntity, &item.PlannedPaymentDate, &item.DocumentNumber,
			&item.DocumentDate, &item.PaymentPurpose, &item.Comment, &item.Amount,
			&item.PaidAmount, &item.OutstandingAmount, &item.Status, &item.ApprovalDate,
		); scanErr != nil {
			fail(w, http.StatusInternalServerError, "Ошибка данных счетов по аренде")
			return
		}
		items = append(items, item)
		amount += item.Amount
		paidAmount += item.PaidAmount
		outstandingAmount += item.OutstandingAmount
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		fail(w, http.StatusInternalServerError, "Ошибка данных счетов по аренде")
		return
	}
	lastDay := time.Date(reportDate.Year(), reportDate.Month()+1, 0, 0, 0, 0, 0, reportDate.Location())
	writeJSON(w, http.StatusOK, map[string]any{
		"id": executiveSpecialSectionID, "title": executiveSpecialTitle,
		"period":        map[string]any{"key": "special", "title": "До конца месяца, включая просроченные", "to": lastDay.Format("2006-01-02")},
		"cost_category": executiveSpecialTitle,
		"count":         len(items), "amount": amount, "paid_amount": paidAmount,
		"outstanding_amount": outstandingAmount, "items": items,
	})
}

func (a *app) executiveSettings(w http.ResponseWriter, r *http.Request) {
	enabled, err := a.executiveSpecialEnabled(r)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить настройки панели руководителя")
		return
	}
	writeJSON(w, http.StatusOK, executiveSettingsPayload{KibirevRentEnabled: enabled})
}

func (a *app) updateExecutiveSettings(w http.ResponseWriter, r *http.Request) {
	var input executiveSettingsPayload
	if !decodeJSON(w, r, &input) {
		return
	}
	user := currentUser(r)
	var id int64
	err := a.db.QueryRowContext(r.Context(), `
		INSERT INTO reference_values(kind,value,sort_order,active)
		VALUES($1,$2,0,$3)
		ON CONFLICT(kind,value) DO UPDATE SET active=EXCLUDED.active
		RETURNING id`,
		executiveSettingsReferenceKind, executiveSpecialSectionID, input.KibirevRentEnabled,
	).Scan(&id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить настройки панели руководителя")
		return
	}
	a.audit(r.Context(), user.ID, "update", "executive_setting", &id, map[string]any{
		"setting": executiveSpecialSectionID, "enabled": input.KibirevRentEnabled,
	})
	writeJSON(w, http.StatusOK, input)
}
