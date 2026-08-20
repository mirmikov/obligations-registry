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
	UserAccess  *undoChange `json:"user_access,omitempty"`
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
		"user_access": `SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.id),'[]'::jsonb)
			FROM (
				SELECT u.id,
					s.user_id IS NOT NULL AS has_state,
					COALESCE(s.state,'{}'::jsonb) AS workspace_state,
					COALESCE((
						SELECT jsonb_agg(cm.conversation_id ORDER BY cm.conversation_id)
						FROM chat_members cm
						JOIN chat_conversations c ON c.id=cm.conversation_id
						WHERE cm.user_id=u.id AND c.direct_key LIKE 'accounting-invoice:%'
					),'[]'::jsonb) AS accounting_conversation_ids
				FROM users u
				LEFT JOIN user_workspace_state s ON s.user_id=u.id
				WHERE u.id=ANY($1)
			) row_data`,
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
	if payload.Obligations != nil && !user.IsDeveloper {
		if err = validateApprovalUndo(user, payload.Obligations); err != nil {
			fail(w, http.StatusForbidden, err.Error())
			return
		}
	}
	if payload.UserAccess != nil {
		if err = lockAccountingMailboxRouting(r.Context(), tx); err != nil {
			fail(w, 500, "Не удалось зафиксировать настройки бухгалтерии для отмены")
			return
		}
	}
	for table, change := range map[string]*undoChange{"obligations": payload.Obligations, "reference_values": payload.References, "users": payload.Users, "user_access": payload.UserAccess} {
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
	if payload.UserAccess != nil {
		if err = restoreUserAccess(r.Context(), tx, payload.UserAccess); err != nil {
			fail(w, 500, "Не удалось восстановить роль и права пользователя")
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

func validateApprovalUndo(user authUser, change *undoChange) error {
	if user.IsDeveloper || change == nil {
		return nil
	}
	type row struct {
		ID int64 `json:"id"`
		obligationApprovalState
	}
	var before, after []row
	if err := json.Unmarshal(change.Before, &before); err != nil {
		return err
	}
	if err := json.Unmarshal(change.After, &after); err != nil {
		return err
	}
	current := make(map[int64]obligationApprovalState, len(after))
	for _, item := range after {
		current[item.ID] = item.obligationApprovalState
	}
	for _, target := range before {
		previous, exists := current[target.ID]
		if !exists {
			input := obligationInput{ApprovalDate: target.ApprovalDate, LegalEntity: target.LegalEntity, Status: target.Status}
			if err := validateApprovalCreate(user, input); err != nil {
				return err
			}
			continue
		}
		if err := validateApprovalUpdate(user, previous, obligationInput{ApprovalDate: target.ApprovalDate, LegalEntity: target.LegalEntity, Status: target.Status}); err != nil {
			return err
		}
	}
	return nil
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

type userAccessSnapshotRow struct {
	ID                        int64           `json:"id"`
	HasState                  bool            `json:"has_state"`
	WorkspaceState            json.RawMessage `json:"workspace_state"`
	AccountingConversationIDs []int64         `json:"accounting_conversation_ids"`
}

func restoreUserAccess(ctx context.Context, tx *sql.Tx, change *undoChange) error {
	var before []userAccessSnapshotRow
	if err := json.Unmarshal(change.Before, &before); err != nil {
		return err
	}
	affectedIDs, err := combinedSnapshotIDs(change)
	if err != nil {
		return err
	}
	beforeByID := make(map[int64]userAccessSnapshotRow, len(before))
	for _, row := range before {
		beforeByID[row.ID] = row
	}
	for _, userID := range affectedIDs {
		row, exists := beforeByID[userID]
		if !exists || !row.HasState {
			if _, err = tx.ExecContext(ctx, `DELETE FROM user_workspace_state WHERE user_id=$1`, userID); err != nil {
				return err
			}
		} else {
			state := row.WorkspaceState
			if len(state) == 0 {
				state = json.RawMessage(`{}`)
			}
			if _, err = tx.ExecContext(ctx, `
				INSERT INTO user_workspace_state(user_id,state,updated_at) VALUES($1,$2,now())
				ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,updated_at=now()`, userID, state); err != nil {
				return err
			}
		}

		desired := map[int64]bool{}
		if exists {
			for _, conversationID := range row.AccountingConversationIDs {
				desired[conversationID] = true
			}
		}
		rows, queryErr := tx.QueryContext(ctx, `
			SELECT cm.conversation_id
			FROM chat_members cm
			JOIN chat_conversations c ON c.id=cm.conversation_id
			WHERE cm.user_id=$1 AND c.direct_key LIKE $2`, userID, accountingConversationKeyPrefix+"%")
		if queryErr != nil {
			return queryErr
		}
		current := map[int64]bool{}
		for rows.Next() {
			var conversationID int64
			if err = rows.Scan(&conversationID); err != nil {
				rows.Close()
				return err
			}
			current[conversationID] = true
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for conversationID := range current {
			if !desired[conversationID] {
				if _, err = tx.ExecContext(ctx, `DELETE FROM chat_members WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID); err != nil {
					return err
				}
			}
		}
		for conversationID := range desired {
			if !current[conversationID] {
				if _, err = tx.ExecContext(ctx, `
					INSERT INTO chat_members(conversation_id,user_id,last_read_at)
					SELECT id,$2,'epoch'::timestamptz FROM chat_conversations
					WHERE id=$1 AND direct_key LIKE $3
					ON CONFLICT DO NOTHING`, conversationID, userID, accountingConversationKeyPrefix+"%"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
