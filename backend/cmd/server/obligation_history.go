package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
)

type obligationHistoryChange struct {
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

type obligationHistoryEvent struct {
	ID          int64                     `json:"id"`
	Action      string                    `json:"action"`
	Description string                    `json:"description"`
	User        string                    `json:"user"`
	CreatedAt   string                    `json:"created_at"`
	UndoneAt    string                    `json:"undone_at,omitempty"`
	Changes     []obligationHistoryChange `json:"changes"`
}

var obligationHistoryFields = []string{
	"counterparty", "entry_date", "account_type", "legal_entity", "amount",
	"document_number", "document_date", "cost_category", "deferment_days",
	"planned_payment_date", "approval_date", "actual_payment_date", "status",
	"urgency", "responsible", "priority", "comment", "source_note",
	"split_group_id", "split_parent_id", "installment_number", "installment_count",
}

func snapshotObjectForID(raw json.RawMessage, id int64) map[string]any {
	var rows []map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &rows) != nil {
		return nil
	}
	for _, row := range rows {
		value, ok := row["id"].(float64)
		if ok && int64(value) == id {
			return row
		}
	}
	return nil
}

func obligationHistoryChanges(before, after map[string]any) []obligationHistoryChange {
	changes := []obligationHistoryChange{}
	for _, field := range obligationHistoryFields {
		beforeValue, afterValue := before[field], after[field]
		if before == nil {
			beforeValue = nil
		}
		if after == nil {
			afterValue = nil
		}
		if reflect.DeepEqual(beforeValue, afterValue) {
			continue
		}
		if before == nil && isEmptyHistoryValue(afterValue) {
			continue
		}
		if after == nil && isEmptyHistoryValue(beforeValue) {
			continue
		}
		changes = append(changes, obligationHistoryChange{Field: field, Before: beforeValue, After: afterValue})
	}
	return changes
}

func isEmptyHistoryValue(value any) bool {
	return value == nil || value == "" || value == float64(0)
}

func (a *app) obligationHistory(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, http.StatusBadRequest, "Некорректный ID")
		return
	}

	var record struct {
		Counterparty, DocumentNumber, Status, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy string
		Amount                                                                           float64
	}
	err = a.db.QueryRowContext(r.Context(), `
		SELECT COALESCE(o.counterparty,''),COALESCE(o.document_number,''),COALESCE(o.amount,0)::float8,
			COALESCE(o.status,''),to_char(o.created_at,'YYYY-MM-DD HH24:MI:SS'),
			COALESCE(created.name,'Система'),to_char(o.updated_at,'YYYY-MM-DD HH24:MI:SS'),
			COALESCE(updated.name,created.name,'Система')
		FROM obligations o
		LEFT JOIN users created ON created.id=o.created_by
		LEFT JOIN users updated ON updated.id=o.updated_by
		WHERE o.id=$1`, id,
	).Scan(
		&record.Counterparty, &record.DocumentNumber, &record.Amount, &record.Status,
		&record.CreatedAt, &record.CreatedBy, &record.UpdatedAt, &record.UpdatedBy,
	)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "Запись не найдена")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить информацию о записи")
		return
	}

	rows, err := a.db.QueryContext(r.Context(), `
		SELECT op.id,op.action,op.description,COALESCE(u.name,'Система'),op.payload,
			to_char(op.created_at,'YYYY-MM-DD HH24:MI:SS'),
			COALESCE(to_char(op.undone_at,'YYYY-MM-DD HH24:MI:SS'),'')
		FROM undo_operations op
		LEFT JOIN users u ON u.id=op.user_id
		WHERE COALESCE(op.payload->'obligations'->'before','[]'::jsonb)
				@> jsonb_build_array(jsonb_build_object('id',$1))
			OR COALESCE(op.payload->'obligations'->'after','[]'::jsonb)
				@> jsonb_build_array(jsonb_build_object('id',$1))
		ORDER BY op.id DESC`, id)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить историю изменений")
		return
	}
	defer rows.Close()

	events := []obligationHistoryEvent{}
	for rows.Next() {
		var event obligationHistoryEvent
		var payloadRaw []byte
		if err = rows.Scan(
			&event.ID, &event.Action, &event.Description, &event.User, &payloadRaw,
			&event.CreatedAt, &event.UndoneAt,
		); err != nil {
			fail(w, http.StatusInternalServerError, "Ошибка чтения истории изменений")
			return
		}
		var payload undoPayload
		if json.Unmarshal(payloadRaw, &payload) != nil || payload.Obligations == nil {
			continue
		}
		before := snapshotObjectForID(payload.Obligations.Before, id)
		after := snapshotObjectForID(payload.Obligations.After, id)
		event.Changes = obligationHistoryChanges(before, after)
		if before == nil && after != nil {
			event.Action = "create"
		} else if before != nil && after == nil {
			event.Action = "delete"
		}
		events = append(events, event)
	}
	if err = rows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка чтения истории изменений")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"record": map[string]any{
			"id": id, "counterparty": record.Counterparty, "document_number": record.DocumentNumber,
			"amount": record.Amount, "status": record.Status,
			"created_at": record.CreatedAt, "created_by": record.CreatedBy,
			"updated_at": record.UpdatedAt, "updated_by": record.UpdatedBy,
		},
		"events": events,
	})
}
