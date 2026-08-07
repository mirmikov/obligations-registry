package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
)

const maxCounterpartiesPerMerge = 100

type counterpartyMergeInput struct {
	IDs   []int64 `json:"ids"`
	Value string  `json:"value"`
}

func (input *counterpartyMergeInput) normalize() error {
	input.Value = strings.TrimSpace(input.Value)
	input.IDs = uniqueInt64s(input.IDs)
	filtered := input.IDs[:0]
	for _, id := range input.IDs {
		if id > 0 {
			filtered = append(filtered, id)
		}
	}
	input.IDs = filtered
	if len(input.IDs) < 2 {
		return fmt.Errorf("выберите минимум двух контрагентов")
	}
	if len(input.IDs) > maxCounterpartiesPerMerge {
		return fmt.Errorf("за один раз можно объединить не более %d контрагентов", maxCounterpartiesPerMerge)
	}
	if input.Value == "" {
		return fmt.Errorf("укажите итоговое название контрагента")
	}
	if len([]rune(input.Value)) > 500 {
		return fmt.Errorf("итоговое название слишком длинное")
	}
	return nil
}

type counterpartyMergeReference struct {
	ID    int64
	Value string
}

func (a *app) mergeCounterparties(w http.ResponseWriter, r *http.Request) {
	var input counterpartyMergeInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := input.normalize(); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать объединение контрагентов")
		return
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(r.Context(), `
		SELECT id,value FROM reference_values
		WHERE kind=$1 AND active AND id=ANY($2)
		ORDER BY id FOR UPDATE`, counterpartyReferenceKind, input.IDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить выбранных контрагентов")
		return
	}
	selected := make([]counterpartyMergeReference, 0, len(input.IDs))
	for rows.Next() {
		var item counterpartyMergeReference
		if err = rows.Scan(&item.ID, &item.Value); err != nil {
			rows.Close()
			fail(w, http.StatusInternalServerError, "Не удалось прочитать выбранных контрагентов")
			return
		}
		selected = append(selected, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать выбранных контрагентов")
		return
	}
	rows.Close()
	if len(selected) != len(input.IDs) {
		fail(w, http.StatusConflict, "Список контрагентов изменился. Обновите справочник и повторите объединение")
		return
	}

	var canonicalID int64
	err = tx.QueryRowContext(r.Context(), `
		SELECT id FROM reference_values
		WHERE kind=$1 AND lower(value)=lower($2)
		ORDER BY (value=$2) DESC,active DESC,id
		LIMIT 1 FOR UPDATE`, counterpartyReferenceKind, input.Value).Scan(&canonicalID)
	if err == sql.ErrNoRows {
		canonicalID = selected[0].ID
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось определить итогового контрагента")
		return
	}

	changedReferenceIDs := append([]int64{}, input.IDs...)
	changedReferenceIDs = uniqueInt64s(append(changedReferenceIDs, canonicalID))
	beforeReferences, err := snapshotRows(r.Context(), tx, "reference_values", changedReferenceIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю справочника")
		return
	}

	sourceValues := make([]string, 0, len(selected))
	for _, item := range selected {
		sourceValues = append(sourceValues, item.Value)
	}
	obligationRows, err := tx.QueryContext(r.Context(), `SELECT id FROM obligations WHERE counterparty=ANY($1::text[]) ORDER BY id FOR UPDATE`, sourceValues)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить строки реестра")
		return
	}
	obligationIDs := make([]int64, 0)
	for obligationRows.Next() {
		var id int64
		if err = obligationRows.Scan(&id); err != nil {
			obligationRows.Close()
			fail(w, http.StatusInternalServerError, "Не удалось прочитать строки реестра")
			return
		}
		obligationIDs = append(obligationIDs, id)
	}
	if err = obligationRows.Err(); err != nil {
		obligationRows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать строки реестра")
		return
	}
	obligationRows.Close()
	beforeObligations, err := snapshotRows(r.Context(), tx, "obligations", obligationIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю строк реестра")
		return
	}

	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE kind=$1 AND id=ANY($2) AND id<>$3`, counterpartyReferenceKind, input.IDs, canonicalID); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось архивировать дубли контрагента")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET value=$1,active=true WHERE id=$2 AND kind=$3`, input.Value, canonicalID, counterpartyReferenceKind); err != nil {
		fail(w, http.StatusConflict, "Не удалось сохранить итоговое название: такое значение уже существует")
		return
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE obligations SET counterparty=$1,updated_by=$2,updated_at=now() WHERE id=ANY($3)`, input.Value, user.ID, obligationIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось обновить контрагентов в реестре")
		return
	}
	updated, _ := result.RowsAffected()

	afterReferences, err := snapshotRows(r.Context(), tx, "reference_values", changedReferenceIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить историю справочника")
		return
	}
	afterObligations, err := snapshotRows(r.Context(), tx, "obligations", obligationIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить историю строк реестра")
		return
	}
	description := fmt.Sprintf("Объединение %d контрагентов в «%s»: обновлено %d записей реестра", len(selected), input.Value, updated)
	if err = a.recordUndo(r.Context(), tx, user.ID, "merge", description, undoPayload{
		Obligations: &undoChange{Before: beforeObligations, After: afterObligations},
		References:  &undoChange{Before: beforeReferences, After: afterReferences},
	}); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю объединения")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить объединение контрагентов")
		return
	}

	a.audit(r.Context(), user.ID, "merge", "reference", &canonicalID, map[string]any{
		"kind": counterpartyReferenceKind, "source_ids": input.IDs, "source_values": sourceValues,
		"target_value": input.Value, "updated_obligations": updated,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"id": canonicalID, "value": input.Value, "merged": len(selected), "updated_obligations": updated,
	})
}
