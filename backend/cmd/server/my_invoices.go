package main

import (
	"net/http"
)

type myInvoiceItem struct {
	ID                 int64   `json:"id"`
	AccountType        string  `json:"account_type"`
	EntryDate          string  `json:"entry_date"`
	Counterparty       string  `json:"counterparty"`
	LegalEntity        string  `json:"legal_entity"`
	CostCategory       string  `json:"cost_category"`
	Responsible        string  `json:"responsible"`
	DocumentNumber     string  `json:"document_number"`
	DocumentDate       string  `json:"document_date"`
	Amount             float64 `json:"amount"`
	PlannedPaymentDate string  `json:"planned_payment_date"`
	ApprovalDate       string  `json:"approval_date"`
	ActualPaymentDate  string  `json:"actual_payment_date"`
	Status             string  `json:"status"`
	Urgency            string  `json:"urgency"`
	Comment            string  `json:"comment"`
	SourceNote         string  `json:"source_note"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

func (a *app) myInvoices(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	mappingRows, err := a.db.QueryContext(r.Context(), `
		SELECT m.value,r.id,r.value
		FROM reference_values m
		JOIN reference_values r ON r.id=m.sort_order AND r.kind='responsibles' AND r.active
		WHERE m.kind=$1 AND m.active
		ORDER BY r.sort_order,r.value`, responsibleUserReferenceKind)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось определить ответственных пользователя")
		return
	}
	stored := []storedResponsibleUserReference{}
	for mappingRows.Next() {
		var item storedResponsibleUserReference
		if err = mappingRows.Scan(&item.Encoded, &item.ResponsibleID, &item.ResponsibleName); err != nil {
			mappingRows.Close()
			fail(w, http.StatusInternalServerError, "Не удалось прочитать привязки ответственных")
			return
		}
		stored = append(stored, item)
	}
	if err = mappingRows.Err(); err != nil {
		mappingRows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать привязки ответственных")
		return
	}
	mappingRows.Close()

	responsibles := responsibleNamesForUser(user.ID, stored)
	items := []myInvoiceItem{}
	if len(responsibles) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"responsibles": responsibles, "items": items})
		return
	}

	rows, err := a.db.QueryContext(r.Context(), `
		SELECT id,
			COALESCE(account_type,''),COALESCE(to_char(entry_date,'YYYY-MM-DD'),''),
			COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(cost_category,''),COALESCE(responsible,''),
			COALESCE(document_number,''),COALESCE(to_char(document_date,'YYYY-MM-DD'),''),COALESCE(amount,0)::float8,
			COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),COALESCE(to_char(approval_date,'YYYY-MM-DD'),''),
			COALESCE(to_char(actual_payment_date,'YYYY-MM-DD'),''),COALESCE(status,''),COALESCE(urgency,''),
			COALESCE(comment,''),COALESCE(source_note,''),
			to_char(created_at,'YYYY-MM-DD HH24:MI:SS'),to_char(updated_at,'YYYY-MM-DD HH24:MI:SS')
		FROM obligations
		WHERE responsible=ANY($1::text[])
		ORDER BY COALESCE(planned_payment_date,document_date,entry_date) DESC NULLS LAST,id DESC`, responsibles)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить мои счета")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var item myInvoiceItem
		if err = rows.Scan(
			&item.ID, &item.AccountType, &item.EntryDate, &item.Counterparty, &item.LegalEntity, &item.CostCategory,
			&item.Responsible, &item.DocumentNumber, &item.DocumentDate, &item.Amount, &item.PlannedPaymentDate,
			&item.ApprovalDate, &item.ActualPaymentDate, &item.Status, &item.Urgency, &item.Comment,
			&item.SourceNote, &item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось прочитать мои счета")
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось прочитать мои счета")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"responsibles": responsibles, "items": items})
}
