package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
)

const maxUndoOperationsPerUser = 500

type undoChange struct {
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
}

type undoPayload struct {
	Obligations *undoChange `json:"obligations,omitempty"`
	References  *undoChange `json:"references,omitempty"`
	Users       *undoChange `json:"users,omitempty"`
}

func emptySnapshot() json.RawMessage { return json.RawMessage(`[]`) }

func snapshotRows(ctx context.Context, db dbExecer, table string, ids []int64) (json.RawMessage, error) {
	if len(ids) == 0 {
		return emptySnapshot(), nil
	}
	queries := map[string]string{
		"obligations":      `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) FROM (SELECT * FROM obligations WHERE id=ANY($1)) row_data`,
		"reference_values": `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) FROM (SELECT * FROM reference_values WHERE id=ANY($1)) row_data`,
		"users":            `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) FROM (SELECT * FROM users WHERE id=ANY($1)) row_data`,
	}
	query := queries[table]
	if query == "" {
		return nil, fmt.Errorf("unknown undo table %q", table)
	}
	var value []byte
	if err := db.QueryRowContext(ctx, query, ids).Scan(&value); err != nil {
		return nil, err
	}
	return json.RawMessage(value), nil
}

func snapshotAllReferences(ctx context.Context, db dbExecer) (json.RawMessage, error) {
	var value []byte
	err := db.QueryRowContext(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb) FROM (SELECT * FROM reference_values) row_data`).Scan(&value)
	return json.RawMessage(value), err
}

func snapshotOneObligation(ctx context.Context, db dbExecer, id int64) (json.RawMessage, error) {
	var value []byte
	err := db.QueryRowContext(ctx, `SELECT to_jsonb(row_data) FROM (SELECT * FROM obligations WHERE id=$1 FOR UPDATE) row_data`, id).Scan(&value)
	return json.RawMessage(value), err
}

func snapshotArray(rows []json.RawMessage) (json.RawMessage, error) {
	if rows == nil {
		return emptySnapshot(), nil
	}
	value, err := json.Marshal(rows)
	return json.RawMessage(value), err
}

func snapshotIDs(value json.RawMessage) ([]int64, error) {
	var rows []struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(value, &rows); err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		if row.ID > 0 {
			ids = append(ids, row.ID)
		}
	}
	return ids, nil
}

func combinedSnapshotIDs(change *undoChange) ([]int64, error) {
	before, err := snapshotIDs(change.Before)
	if err != nil {
		return nil, err
	}
	after, err := snapshotIDs(change.After)
	if err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	ids := make([]int64, 0, len(before)+len(after))
	for _, id := range append(before, after...) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func snapshotsEqual(left, right json.RawMessage) bool {
	var a, b any
	return json.Unmarshal(left, &a) == nil && json.Unmarshal(right, &b) == nil && reflect.DeepEqual(a, b)
}

func (a *app) recordUndo(ctx context.Context, db dbExecer, userID int64, action, description string, payload undoPayload) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO undo_operations(user_id,action,description,payload) VALUES($1,$2,$3,$4)`, userID, action, description, data); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `DELETE FROM undo_operations WHERE user_id=$1 AND id NOT IN (SELECT id FROM undo_operations WHERE user_id=$1 ORDER BY id DESC LIMIT $2)`, userID, maxUndoOperationsPerUser)
	return err
}

func (a *app) undoStatus(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	var id int64
	var action, description, created string
	err := a.db.QueryRowContext(r.Context(), `SELECT id,action,description,to_char(created_at,'YYYY-MM-DD HH24:MI:SS') FROM undo_operations WHERE user_id=$1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1`, user.ID).Scan(&id, &action, &description, &created)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, 200, map[string]any{"available": false, "remaining": 0})
		return
	}
	if err != nil {
		fail(w, 500, "Не удалось проверить историю отмены")
		return
	}
	var remaining int
	_ = a.db.QueryRowContext(r.Context(), `SELECT count(*) FROM undo_operations WHERE user_id=$1 AND undone_at IS NULL`, user.ID).Scan(&remaining)
	writeJSON(w, 200, map[string]any{"available": true, "id": id, "action": action, "description": description, "created_at": created, "remaining": remaining})
}

func (a *app) undoLast(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать отмену")
		return
	}
	defer tx.Rollback()
	var id int64
	var action, description string
	var raw []byte
	err = tx.QueryRowContext(r.Context(), `SELECT id,action,description,payload FROM undo_operations WHERE user_id=$1 AND undone_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`, user.ID).Scan(&id, &action, &description, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 409, "Нет действий, которые можно отменить")
		return
	}
	if err != nil {
		fail(w, 500, "Не удалось загрузить действие для отмены")
		return
	}
	var payload undoPayload
	if err = json.Unmarshal(raw, &payload); err != nil {
		fail(w, 500, "История отмены повреждена")
		return
	}
	for table, change := range map[string]*undoChange{"obligations": payload.Obligations, "reference_values": payload.References, "users": payload.Users} {
		if change == nil {
			continue
		}
		ids, idsErr := combinedSnapshotIDs(change)
		if idsErr != nil {
			fail(w, 500, "История отмены повреждена")
			return
		}
		current, snapshotErr := snapshotRows(r.Context(), tx, table, ids)
		if snapshotErr != nil {
			fail(w, 500, "Не удалось проверить текущее состояние данных")
			return
		}
		if !snapshotsEqual(current, change.After) {
			fail(w, 409, "Отмена невозможна: затронутые данные уже изменились после этого действия")
			return
		}
	}
	if payload.Obligations != nil {
		if err = restoreObligations(r.Context(), tx, payload.Obligations); err != nil {
			fail(w, 500, "Не удалось восстановить записи реестра: "+err.Error())
			return
		}
	}
	if payload.References != nil {
		if err = restoreReferences(r.Context(), tx, payload.References); err != nil {
			fail(w, 500, "Не удалось восстановить справочники")
			return
		}
	}
	if payload.Users != nil {
		if err = restoreUsers(r.Context(), tx, payload.Users); err != nil {
			fail(w, 409, "Пользователя нельзя восстановить: у его записи появились связанные данные")
			return
		}
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE undo_operations SET undone_at=now() WHERE id=$1`, id); err != nil {
		fail(w, 500, "Не удалось завершить отмену")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить отмену")
		return
	}
	a.audit(r.Context(), user.ID, "undo", "operation", &id, map[string]any{"action": action, "description": description})
	writeJSON(w, 200, map[string]any{"undone": true, "id": id, "description": description})
}

func restoreObligations(ctx context.Context, tx *sql.Tx, change *undoChange) error {
	afterIDs, err := snapshotIDs(change.After)
	if err != nil {
		return err
	}
	beforeIDs, err := snapshotIDs(change.Before)
	if err != nil {
		return err
	}
	keep := map[int64]bool{}
	for _, id := range beforeIDs {
		keep[id] = true
	}
	remove := []int64{}
	for _, id := range afterIDs {
		if !keep[id] {
			remove = append(remove, id)
		}
	}
	if len(remove) > 0 {
		if _, err = tx.ExecContext(ctx, `DELETE FROM obligations WHERE id=ANY($1)`, remove); err != nil {
			return err
		}
	}
	if len(beforeIDs) == 0 {
		return nil
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO obligations(id,source_row,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,amount,planned_payment_date,approval_date,actual_payment_date,status,urgency,comment,source_note,created_by,updated_by,created_at,updated_at,split_group_id,split_parent_id,installment_number,installment_count)
		SELECT id,source_row,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,amount,planned_payment_date,approval_date,actual_payment_date,status,urgency,comment,source_note,created_by,updated_by,created_at,updated_at,split_group_id,split_parent_id,installment_number,installment_count
		FROM jsonb_to_recordset($1::jsonb) AS restored(id bigint,source_row integer,account_type text,entry_date date,counterparty text,legal_entity text,cost_category text,priority text,responsible text,document_number text,deferment_days integer,document_date date,amount numeric,planned_payment_date date,approval_date date,actual_payment_date date,status text,urgency text,comment text,source_note text,created_by bigint,updated_by bigint,created_at timestamptz,updated_at timestamptz,split_group_id text,split_parent_id bigint,installment_number integer,installment_count integer)
		ON CONFLICT(id) DO UPDATE SET source_row=excluded.source_row,account_type=excluded.account_type,entry_date=excluded.entry_date,counterparty=excluded.counterparty,legal_entity=excluded.legal_entity,cost_category=excluded.cost_category,priority=excluded.priority,responsible=excluded.responsible,document_number=excluded.document_number,deferment_days=excluded.deferment_days,document_date=excluded.document_date,amount=excluded.amount,planned_payment_date=excluded.planned_payment_date,approval_date=excluded.approval_date,actual_payment_date=excluded.actual_payment_date,status=excluded.status,urgency=excluded.urgency,comment=excluded.comment,source_note=excluded.source_note,created_by=excluded.created_by,updated_by=excluded.updated_by,created_at=excluded.created_at,updated_at=excluded.updated_at,split_group_id=excluded.split_group_id,split_parent_id=excluded.split_parent_id,installment_number=excluded.installment_number,installment_count=excluded.installment_count`, change.Before)
	return err
}

func restoreReferences(ctx context.Context, tx *sql.Tx, change *undoChange) error {
	afterIDs, err := snapshotIDs(change.After)
	if err != nil {
		return err
	}
	beforeIDs, err := snapshotIDs(change.Before)
	if err != nil {
		return err
	}
	keep := map[int64]bool{}
	for _, id := range beforeIDs {
		keep[id] = true
	}
	remove := []int64{}
	for _, id := range afterIDs {
		if !keep[id] {
			remove = append(remove, id)
		}
	}
	if len(remove) > 0 {
		if _, err = tx.ExecContext(ctx, `DELETE FROM reference_values WHERE id=ANY($1)`, remove); err != nil {
			return err
		}
	}
	if len(beforeIDs) == 0 {
		return nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO reference_values(id,kind,value,sort_order,active,tax_id) SELECT id,kind,value,sort_order,active,tax_id FROM jsonb_to_recordset($1::jsonb) AS restored(id bigint,kind text,value text,sort_order integer,active boolean,tax_id text) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,value=excluded.value,sort_order=excluded.sort_order,active=excluded.active,tax_id=excluded.tax_id`, change.Before)
	return err
}

func restoreUsers(ctx context.Context, tx *sql.Tx, change *undoChange) error {
	afterIDs, err := snapshotIDs(change.After)
	if err != nil {
		return err
	}
	beforeIDs, err := snapshotIDs(change.Before)
	if err != nil {
		return err
	}
	keep := map[int64]bool{}
	for _, id := range beforeIDs {
		keep[id] = true
	}
	remove := []int64{}
	for _, id := range afterIDs {
		if !keep[id] {
			remove = append(remove, id)
		}
	}
	if len(remove) > 0 {
		if _, err = tx.ExecContext(ctx, `DELETE FROM users WHERE id=ANY($1)`, remove); err != nil {
			return err
		}
	}
	if len(beforeIDs) == 0 {
		return nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO users(id,name,email,password_hash,role,active,created_at,updated_at) SELECT id,name,email,password_hash,role,active,created_at,updated_at FROM jsonb_to_recordset($1::jsonb) AS restored(id bigint,name text,email text,password_hash text,role text,active boolean,created_at timestamptz,updated_at timestamptz) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,password_hash=excluded.password_hash,role=excluded.role,active=excluded.active,created_at=excluded.created_at,updated_at=excluded.updated_at`, change.Before)
	return err
}
