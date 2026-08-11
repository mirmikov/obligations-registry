package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
)

const responsibleUserReferenceKind = "responsible_users"

type responsibleUserReference struct {
	ResponsibleID int64 `json:"responsible_id"`
	UserID        int64 `json:"user_id"`
}

func encodeResponsibleUserReference(responsibleID, userID int64) string {
	value, _ := json.Marshal(responsibleUserReference{ResponsibleID: responsibleID, UserID: userID})
	return string(value)
}

func decodeResponsibleUserReference(value string) (responsibleUserReference, bool) {
	var result responsibleUserReference
	if json.Unmarshal([]byte(value), &result) != nil || result.ResponsibleID <= 0 || result.UserID <= 0 {
		return responsibleUserReference{}, false
	}
	return result, true
}

func (a *app) listAssignableUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT id,name,email
		FROM users
		WHERE active
		ORDER BY lower(name),lower(email),id`)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить пользователей для привязки")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, email string
		if err = rows.Scan(&id, &name, &email); err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось прочитать пользователей для привязки")
			return
		}
		items = append(items, map[string]any{"id": id, "name": name, "email": email})
	}
	if err = rows.Err(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось прочитать пользователей для привязки")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *app) setResponsibleUser(w http.ResponseWriter, r *http.Request) {
	responsibleID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || responsibleID <= 0 {
		fail(w, http.StatusBadRequest, "Некорректный ответственный")
		return
	}
	var input struct {
		UserID *int64 `json:"user_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.UserID != nil && *input.UserID <= 0 {
		fail(w, http.StatusBadRequest, "Некорректный пользователь")
		return
	}

	actor := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать сохранение привязки")
		return
	}
	defer tx.Rollback()

	var responsibleName string
	if err = tx.QueryRowContext(r.Context(), `SELECT value FROM reference_values WHERE id=$1 AND kind='responsibles' AND active FOR UPDATE`, responsibleID).Scan(&responsibleName); err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "Ответственный не найден")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить ответственного")
		return
	}

	var userName, userEmail string
	if input.UserID != nil {
		if err = tx.QueryRowContext(r.Context(), `SELECT name,email FROM users WHERE id=$1 AND active FOR UPDATE`, *input.UserID).Scan(&userName, &userEmail); err == sql.ErrNoRows {
			fail(w, http.StatusBadRequest, "Активный пользователь не найден")
			return
		} else if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось проверить пользователя")
			return
		}
	}

	rows, err := tx.QueryContext(r.Context(), `SELECT id FROM reference_values WHERE kind=$1 AND sort_order=$2 FOR UPDATE`, responsibleUserReferenceKind, responsibleID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить привязку")
		return
	}
	changedIDs := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			changedIDs = append(changedIDs, id)
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать текущую привязку")
		return
	}
	rows.Close()

	before, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю изменения")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE kind=$1 AND sort_order=$2`, responsibleUserReferenceKind, responsibleID); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось обновить привязку")
		return
	}

	if input.UserID != nil {
		encoded := encodeResponsibleUserReference(responsibleID, *input.UserID)
		var mappingID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO reference_values(kind,value,sort_order,active) VALUES($1,$2,$3,true)
			ON CONFLICT(kind,value) DO UPDATE SET sort_order=excluded.sort_order,active=true
			RETURNING id`, responsibleUserReferenceKind, encoded, responsibleID).Scan(&mappingID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось сохранить привязку")
			return
		}
		changedIDs = append(changedIDs, mappingID)
	}

	changedIDs = uniqueInt64s(changedIDs)
	after, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	description := fmt.Sprintf("Изменение пользователя для ответственного «%s»", responsibleName)
	if err != nil || a.recordUndo(r.Context(), tx, actor.ID, "update", description, undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю изменения")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить сохранение привязки")
		return
	}

	details := map[string]any{"kind": responsibleUserReferenceKind, "responsible": responsibleName, "user_id": input.UserID, "user_name": userName, "user_email": userEmail}
	a.audit(r.Context(), actor.ID, "update", "reference", &responsibleID, details)
	writeJSON(w, http.StatusOK, map[string]any{"responsible_id": responsibleID, "user_id": input.UserID})
}

type storedResponsibleUserReference struct {
	Encoded         string
	ResponsibleID   int64
	ResponsibleName string
}

func responsibleNamesForUser(userID int64, stored []storedResponsibleUserReference) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, item := range stored {
		mapping, ok := decodeResponsibleUserReference(item.Encoded)
		if !ok || mapping.UserID != userID || mapping.ResponsibleID != item.ResponsibleID || item.ResponsibleName == "" {
			continue
		}
		if _, exists := seen[item.ResponsibleName]; exists {
			continue
		}
		seen[item.ResponsibleName] = struct{}{}
		result = append(result, item.ResponsibleName)
	}
	sort.Strings(result)
	return result
}
