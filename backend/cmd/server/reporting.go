package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const costCategoryResponsibleReferenceKind = "cost_category_responsibles"

const counterpartyReferenceKind = "counterparties"

const counterpartyDefermentReferenceKind = "counterparty_deferments"

const maxCounterpartyDefermentDays = 36500

func normalizeCounterpartyTaxID(value string) (string, error) {
	value = strings.Map(func(char rune) rune {
		if unicode.IsSpace(char) || char == '-' {
			return -1
		}
		return char
	}, strings.TrimSpace(value))
	if value == "" {
		return "", nil
	}
	if len(value) != 10 && len(value) != 12 {
		return "", fmt.Errorf("ИНН должен содержать 10 или 12 цифр")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return "", fmt.Errorf("ИНН должен содержать только цифры")
		}
	}
	return value, nil
}

type counterpartyTaxIDConflict struct {
	ID     int64
	Value  string
	Active bool
}

func counterpartyTaxIDReassignment(conflict *counterpartyTaxIDConflict, taxID string) (*counterpartyTaxIDConflict, error) {
	if conflict == nil {
		return nil, nil
	}
	if conflict.Active {
		return nil, fmt.Errorf("Контрагент с ИНН %s уже существует: %s", taxID, conflict.Value)
	}
	return conflict, nil
}

func normalizeCounterpartyAliases(value string, aliases []string) []string {
	seen := map[string]struct{}{strings.ToLower(strings.TrimSpace(value)): {}}
	result := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		key := strings.ToLower(alias)
		if alias == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, alias)
	}
	return result
}

func (a *app) counterpartyAliases(ctx context.Context) (map[int64][]string, error) {
	rows, err := a.db.QueryContext(ctx, `
		SELECT audit.entity_id, source_value.value
		FROM audit_log audit
		CROSS JOIN LATERAL jsonb_array_elements_text(
			CASE WHEN jsonb_typeof(audit.details->'source_values')='array'
				THEN audit.details->'source_values' ELSE '[]'::jsonb END
		) WITH ORDINALITY AS source_value(value, position)
		WHERE audit.action='merge' AND audit.entity_type='reference'
			AND audit.entity_id IS NOT NULL AND audit.details->>'kind'=$1
		ORDER BY audit.id, source_value.position`, counterpartyReferenceKind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64][]string{}
	for rows.Next() {
		var id int64
		var alias string
		if err := rows.Scan(&id, &alias); err != nil {
			return nil, err
		}
		result[id] = append(result[id], alias)
	}
	return result, rows.Err()
}

type costCategoryResponsibleReference struct {
	CategoryID  int64  `json:"category_id"`
	Responsible string `json:"responsible"`
}

type counterpartyDefermentReference struct {
	CounterpartyID int64 `json:"counterparty_id"`
	DefermentDays  int   `json:"deferment_days"`
}

func encodeCounterpartyDefermentReference(counterpartyID int64, defermentDays int) string {
	value, _ := json.Marshal(counterpartyDefermentReference{CounterpartyID: counterpartyID, DefermentDays: defermentDays})
	return string(value)
}

func decodeCounterpartyDefermentReference(value string) (counterpartyDefermentReference, bool) {
	var result counterpartyDefermentReference
	if json.Unmarshal([]byte(value), &result) != nil || result.CounterpartyID <= 0 || result.DefermentDays < 0 || result.DefermentDays > maxCounterpartyDefermentDays {
		return counterpartyDefermentReference{}, false
	}
	return result, true
}

func applyCounterpartyDefermentDefault(ctx context.Context, db dbExecer, input *obligationInput) error {
	if input == nil || input.DefermentDays != nil || strings.TrimSpace(input.Counterparty) == "" {
		return nil
	}
	var encoded string
	err := db.QueryRowContext(ctx, `
		SELECT mapping.value
		FROM reference_values counterparty
		JOIN reference_values mapping ON mapping.kind=$2 AND mapping.sort_order=counterparty.id AND mapping.active
		WHERE counterparty.kind=$3 AND counterparty.active AND counterparty.value=$1
		ORDER BY mapping.id DESC LIMIT 1`, strings.TrimSpace(input.Counterparty), counterpartyDefermentReferenceKind, counterpartyReferenceKind).Scan(&encoded)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	mapping, ok := decodeCounterpartyDefermentReference(encoded)
	if !ok {
		return nil
	}
	days := mapping.DefermentDays
	input.DefermentDays = &days
	return nil
}

func encodeCostCategoryResponsibleReference(categoryID int64, responsible string) string {
	value, _ := json.Marshal(costCategoryResponsibleReference{CategoryID: categoryID, Responsible: strings.TrimSpace(responsible)})
	return string(value)
}

func decodeCostCategoryResponsibleReference(value string) (costCategoryResponsibleReference, bool) {
	var result costCategoryResponsibleReference
	if json.Unmarshal([]byte(value), &result) != nil || result.CategoryID <= 0 || strings.TrimSpace(result.Responsible) == "" {
		return costCategoryResponsibleReference{}, false
	}
	result.Responsible = strings.TrimSpace(result.Responsible)
	return result, true
}

func (a *app) listReferences(w http.ResponseWriter, r *http.Request) {
	counterpartyAliases, err := a.counterpartyAliases(r.Context())
	if err != nil {
		fail(w, 500, "Не удалось загрузить историю объединения контрагентов")
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,kind,value,sort_order,tax_id FROM reference_values WHERE active AND kind <> $1 ORDER BY kind,sort_order,value`, executiveSettingsReferenceKind)
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
		var taxID sql.NullString
		if err := rows.Scan(&id, &kind, &value, &order, &taxID); err != nil {
			fail(w, 500, "Ошибка справочников")
			return
		}
		if kind == costCategoryResponsibleReferenceKind {
			mapping, ok := decodeCostCategoryResponsibleReference(value)
			if ok {
				result[kind] = append(result[kind], map[string]any{"id": id, "cost_category_id": mapping.CategoryID, "responsible": mapping.Responsible})
			}
			continue
		}
		if kind == counterpartyDefermentReferenceKind {
			mapping, ok := decodeCounterpartyDefermentReference(value)
			if ok && mapping.CounterpartyID == int64(order) {
				result[kind] = append(result[kind], map[string]any{"id": id, "counterparty_id": mapping.CounterpartyID, "deferment_days": mapping.DefermentDays})
			}
			continue
		}
		if kind == responsibleUserReferenceKind {
			user := currentUser(r)
			if user.IsDeveloper || user.Permissions["references.edit"] {
				mapping, ok := decodeResponsibleUserReference(value)
				if ok && mapping.ResponsibleID == int64(order) {
					result[kind] = append(result[kind], map[string]any{"id": id, "responsible_id": mapping.ResponsibleID, "user_id": mapping.UserID})
				}
			}
			continue
		}
		item := map[string]any{"id": id, "value": value, "sort_order": order}
		if kind == counterpartyReferenceKind {
			item["tax_id"] = taxID.String
			item["aliases"] = normalizeCounterpartyAliases(value, counterpartyAliases[id])
		}
		result[kind] = append(result[kind], item)
	}
	writeJSON(w, 200, result)
}

func (a *app) setCounterpartyDeferment(w http.ResponseWriter, r *http.Request) {
	counterpartyID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || counterpartyID <= 0 {
		fail(w, http.StatusBadRequest, "Некорректный контрагент")
		return
	}
	var input struct {
		DefermentDays *int `json:"deferment_days"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.DefermentDays != nil && (*input.DefermentDays < 0 || *input.DefermentDays > maxCounterpartyDefermentDays) {
		fail(w, http.StatusBadRequest, "Отсрочка должна быть целым числом от 0 до 36500 дней")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать сохранение отсрочки")
		return
	}
	defer tx.Rollback()

	var counterparty string
	if err = tx.QueryRowContext(r.Context(), `SELECT value FROM reference_values WHERE id=$1 AND kind=$2 AND active FOR UPDATE`, counterpartyID, counterpartyReferenceKind).Scan(&counterparty); err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "Контрагент не найден")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить контрагента")
		return
	}

	rows, err := tx.QueryContext(r.Context(), `SELECT id FROM reference_values WHERE kind=$1 AND sort_order=$2 ORDER BY id FOR UPDATE`, counterpartyDefermentReferenceKind, counterpartyID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить настройку отсрочки")
		return
	}
	var changedIDs []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			changedIDs = append(changedIDs, id)
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать настройку отсрочки")
		return
	}
	rows.Close()
	before, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю изменения")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE kind=$1 AND sort_order=$2`, counterpartyDefermentReferenceKind, counterpartyID); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось обновить настройку отсрочки")
		return
	}
	if input.DefermentDays != nil {
		encoded := encodeCounterpartyDefermentReference(counterpartyID, *input.DefermentDays)
		var mappingID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO reference_values(kind,value,sort_order,active) VALUES($1,$2,$3,true)
			ON CONFLICT(kind,value) DO UPDATE SET sort_order=excluded.sort_order,active=true
			RETURNING id`, counterpartyDefermentReferenceKind, encoded, counterpartyID).Scan(&mappingID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось сохранить отсрочку")
			return
		}
		changedIDs = append(changedIDs, mappingID)
	}
	changedIDs = uniqueInt64s(changedIDs)
	after, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "update", "Изменение отсрочки по умолчанию для контрагента «"+counterparty+"»", undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю изменения")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить сохранение отсрочки")
		return
	}
	a.audit(r.Context(), user.ID, "update", "reference", &counterpartyID, map[string]any{"kind": counterpartyDefermentReferenceKind, "counterparty": counterparty, "deferment_days": input.DefermentDays})
	writeJSON(w, http.StatusOK, map[string]any{"counterparty_id": counterpartyID, "deferment_days": input.DefermentDays})
}

func (a *app) setCostCategoryResponsible(w http.ResponseWriter, r *http.Request) {
	categoryID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || categoryID <= 0 {
		fail(w, http.StatusBadRequest, "Некорректная статья затрат")
		return
	}
	var input struct {
		Responsible string `json:"responsible"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Responsible = strings.TrimSpace(input.Responsible)
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()

	var category string
	if err = tx.QueryRowContext(r.Context(), `SELECT value FROM reference_values WHERE id=$1 AND kind='cost_categories' AND active FOR UPDATE`, categoryID).Scan(&category); err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "Статья затрат не найдена")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить статью затрат")
		return
	}
	if input.Responsible != "" {
		var exists bool
		if err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM reference_values WHERE kind='responsibles' AND value=$1 AND active)`, input.Responsible).Scan(&exists); err != nil || !exists {
			fail(w, http.StatusBadRequest, "Ответственный отсутствует в справочнике")
			return
		}
	}

	rows, err := tx.QueryContext(r.Context(), `SELECT id FROM reference_values WHERE kind=$1 AND sort_order=$2 FOR UPDATE`, costCategoryResponsibleReferenceKind, categoryID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить привязку")
		return
	}
	var changedIDs []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			changedIDs = append(changedIDs, id)
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, http.StatusInternalServerError, "Не удалось прочитать существующую привязку")
		return
	}
	rows.Close()
	before, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю изменения")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE kind=$1 AND sort_order=$2`, costCategoryResponsibleReferenceKind, categoryID); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось обновить привязку")
		return
	}
	if input.Responsible != "" {
		encoded := encodeCostCategoryResponsibleReference(categoryID, input.Responsible)
		var mappingID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO reference_values(kind,value,sort_order,active) VALUES($1,$2,$3,true)
			ON CONFLICT(kind,value) DO UPDATE SET sort_order=excluded.sort_order,active=true
			RETURNING id`, costCategoryResponsibleReferenceKind, encoded, categoryID).Scan(&mappingID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "Не удалось сохранить привязку")
			return
		}
		changedIDs = append(changedIDs, mappingID)
	}
	changedIDs = uniqueInt64s(changedIDs)
	after, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "update", "Изменение ответственного для статьи затрат «"+category+"»", undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю изменения")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "update", "reference", &categoryID, map[string]any{"kind": costCategoryResponsibleReferenceKind, "cost_category": category, "responsible": input.Responsible})
	writeJSON(w, http.StatusOK, map[string]any{"cost_category_id": categoryID, "responsible": input.Responsible})
}

func uniqueInt64s(values []int64) []int64 {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (a *app) addReference(w http.ResponseWriter, r *http.Request) {
	kind := normalizeReferenceKind(r.PathValue("kind"))
	if kind == "" {
		fail(w, 400, "Неизвестный справочник")
		return
	}
	var input struct {
		Value   string `json:"value"`
		TaxID   string `json:"tax_id"`
		NewOnly bool   `json:"new_only"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Value = strings.TrimSpace(input.Value)
	if input.Value == "" {
		fail(w, 400, "Пустое значение")
		return
	}
	if kind == counterpartyReferenceKind {
		normalizedTaxID, normalizeErr := normalizeCounterpartyTaxID(input.TaxID)
		if normalizeErr != nil {
			fail(w, http.StatusBadRequest, normalizeErr.Error())
			return
		}
		input.TaxID = normalizedTaxID
	} else {
		input.TaxID = ""
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	var existingID int64
	before := emptySnapshot()
	err = tx.QueryRowContext(r.Context(), `SELECT id FROM reference_values WHERE kind=$1 AND value=$2 FOR UPDATE`, kind, input.Value).Scan(&existingID)
	if kind == counterpartyReferenceKind && input.NewOnly {
		var existingValue string
		nameErr := tx.QueryRowContext(r.Context(), `SELECT value FROM reference_values WHERE kind=$1 AND lower(value)=lower($2) ORDER BY active DESC,id LIMIT 1 FOR UPDATE`, kind, input.Value).Scan(&existingValue)
		if nameErr == nil {
			fail(w, http.StatusConflict, "Контрагент с таким названием уже существует: "+existingValue+". Существующая запись не изменена")
			return
		}
		if nameErr != sql.ErrNoRows {
			fail(w, http.StatusInternalServerError, "Не удалось проверить дублирование контрагента")
			return
		}
	}
	if err == nil {
		before, err = snapshotRows(r.Context(), tx, "reference_values", []int64{existingID})
	}
	if err != nil && err != sql.ErrNoRows {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	if input.TaxID != "" {
		var duplicateID int64
		var duplicateValue string
		err = tx.QueryRowContext(r.Context(), `SELECT id,value FROM reference_values WHERE kind=$1 AND tax_id=$2 AND id<>$3 FOR UPDATE`, counterpartyReferenceKind, input.TaxID, existingID).Scan(&duplicateID, &duplicateValue)
		if err == nil {
			fail(w, http.StatusConflict, fmt.Sprintf("Контрагент с ИНН %s уже существует: %s", input.TaxID, duplicateValue))
			return
		}
		if err != sql.ErrNoRows {
			fail(w, http.StatusInternalServerError, "Не удалось проверить уникальность ИНН")
			return
		}
	}
	var id int64
	if kind == counterpartyReferenceKind && input.NewOnly {
		err = tx.QueryRowContext(r.Context(), `INSERT INTO reference_values(kind,value,sort_order,tax_id) VALUES($1,$2,(SELECT COALESCE(max(sort_order),-1)+1 FROM reference_values WHERE kind=$1),NULLIF($3,'')) RETURNING id`, kind, input.Value, input.TaxID).Scan(&id)
	} else {
		err = tx.QueryRowContext(r.Context(), `INSERT INTO reference_values(kind,value,sort_order,tax_id) VALUES($1,$2,(SELECT COALESCE(max(sort_order),-1)+1 FROM reference_values WHERE kind=$1),NULLIF($3,'')) ON CONFLICT(kind,value) DO UPDATE SET active=true,tax_id=COALESCE(excluded.tax_id,reference_values.tax_id) RETURNING id`, kind, input.Value, input.TaxID).Scan(&id)
	}
	if err != nil {
		if kind == counterpartyReferenceKind && input.NewOnly {
			fail(w, http.StatusConflict, "Контрагент уже существует. Существующая запись не изменена")
		} else {
			fail(w, 400, "Не удалось добавить значение")
		}
		return
	}
	after, err := snapshotRows(r.Context(), tx, "reference_values", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "create", "Добавление значения справочника «"+input.Value+"»", undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "create", "reference", &id, map[string]any{"kind": kind, "value": input.Value, "tax_id": input.TaxID})
	writeJSON(w, 201, map[string]any{"id": id, "tax_id": input.TaxID})
}

func (a *app) addRegistryCounterparty(w http.ResponseWriter, r *http.Request) {
	r.SetPathValue("kind", counterpartyReferenceKind)
	a.addReference(w, r)
}

func (a *app) setCounterpartyTaxID(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		fail(w, http.StatusBadRequest, "Некорректный контрагент")
		return
	}
	var input struct {
		TaxID string `json:"tax_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.TaxID, err = normalizeCounterpartyTaxID(input.TaxID)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать сохранение ИНН")
		return
	}
	defer tx.Rollback()
	var value string
	if err = tx.QueryRowContext(r.Context(), `SELECT value FROM reference_values WHERE id=$1 AND kind=$2 AND active FOR UPDATE`, id, counterpartyReferenceKind).Scan(&value); err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "Контрагент не найден")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить контрагента")
		return
	}
	var reassignedFrom *counterpartyTaxIDConflict
	if input.TaxID != "" {
		var conflict counterpartyTaxIDConflict
		err = tx.QueryRowContext(r.Context(), `SELECT id,value,active FROM reference_values WHERE kind=$1 AND tax_id=$2 AND id<>$3 FOR UPDATE`, counterpartyReferenceKind, input.TaxID, id).Scan(&conflict.ID, &conflict.Value, &conflict.Active)
		if err == nil {
			reassignedFrom, err = counterpartyTaxIDReassignment(&conflict, input.TaxID)
			if err != nil {
				fail(w, http.StatusConflict, err.Error())
				return
			}
		}
		if err != sql.ErrNoRows {
			if err != nil {
				fail(w, http.StatusInternalServerError, "Не удалось проверить уникальность ИНН")
				return
			}
		}
	}
	changedIDs := []int64{id}
	if reassignedFrom != nil {
		changedIDs = append(changedIDs, reassignedFrom.ID)
	}
	before, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить историю изменения")
		return
	}
	if reassignedFrom != nil {
		result, releaseErr := tx.ExecContext(r.Context(), `UPDATE reference_values SET tax_id=NULL WHERE id=$1 AND kind=$2 AND NOT active`, reassignedFrom.ID, counterpartyReferenceKind)
		if releaseErr != nil {
			fail(w, http.StatusInternalServerError, "Не удалось освободить ИНН архивного контрагента")
			return
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			fail(w, http.StatusConflict, "Архивная запись контрагента изменилась. Обновите страницу и повторите попытку")
			return
		}
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE reference_values SET tax_id=NULLIF($1,'') WHERE id=$2 AND kind=$3`, input.TaxID, id, counterpartyReferenceKind); err != nil {
		fail(w, http.StatusConflict, "Не удалось сохранить ИНН: проверьте, что он не используется другим контрагентом")
		return
	}
	after, err := snapshotRows(r.Context(), tx, "reference_values", changedIDs)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "update", "Изменение ИНН контрагента «"+value+"»", undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю изменения")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить сохранение ИНН")
		return
	}
	auditDetails := map[string]any{"kind": counterpartyReferenceKind, "value": value, "tax_id": input.TaxID}
	response := map[string]any{"id": id, "tax_id": input.TaxID}
	if reassignedFrom != nil {
		reassignment := map[string]any{"id": reassignedFrom.ID, "value": reassignedFrom.Value}
		auditDetails["tax_id_reassigned_from"] = reassignment
		response["reassigned_from"] = reassignment
	}
	a.audit(r.Context(), user.ID, "update", "reference", &id, auditDetails)
	writeJSON(w, http.StatusOK, response)
}

func (a *app) deleteReference(w http.ResponseWriter, r *http.Request) {
	kind := normalizeReferenceKind(r.PathValue("kind"))
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if kind == "" || err != nil {
		fail(w, 400, "Некорректные данные")
		return
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать удаление")
		return
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(r.Context(), `SELECT id FROM reference_values WHERE id=$1 AND kind=$2 FOR UPDATE`, id, kind).Scan(&id); err == sql.ErrNoRows {
		fail(w, 404, "Значение не найдено")
		return
	} else if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	before, err := snapshotRows(r.Context(), tx, "reference_values", []int64{id})
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	result, err := tx.ExecContext(r.Context(), `UPDATE reference_values SET active=false WHERE id=$1 AND kind=$2`, id, kind)
	if err != nil {
		fail(w, 500, "Не удалось удалить значение")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		fail(w, 404, "Значение не найдено")
		return
	}
	after, err := snapshotRows(r.Context(), tx, "reference_values", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "delete", fmt.Sprintf("Удаление значения справочника №%d", id), undoPayload{References: &undoChange{Before: before, After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить удаление")
		return
	}
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

const paymentRegisterDefaultStatusPredicate = "BTRIM(COALESCE(status,'')) IN ('К оплате','Оплачено')"

func paymentRegisterStatusWhere(where, requestedStatus string) string {
	if strings.TrimSpace(requestedStatus) == "" {
		return where + " AND " + paymentRegisterDefaultStatusPredicate
	}
	return where
}

func (a *app) paymentRegister(w http.ResponseWriter, r *http.Request) {
	where, args := buildFilters(r, 1)
	where = paymentRegisterStatusWhere(where, r.URL.Query().Get("status"))
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
		if scan, ok := readObligationScan(item.ID); ok {
			item.HasScan = true
			item.ScanName = scan.OriginalName
			item.ScanSize = scan.Size
			item.ScanUpdatedAt = scan.UpdatedAt
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

type workspaceState struct {
	Page             string `json:"page"`
	SidebarCollapsed bool   `json:"sidebar_collapsed"`
}

func normalizeWorkspaceState(value workspaceState) workspaceState {
	switch value.Page {
	case "dashboard", "my-invoices", "executive", "registry", "credits-leasing", "payments", "chat", "references", "users", "audit":
	default:
		value.Page = "dashboard"
	}
	return value
}

func (a *app) getWorkspaceState(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	var raw []byte
	if err := a.db.QueryRowContext(r.Context(), `SELECT state FROM user_workspace_state WHERE user_id=$1`, user.ID).Scan(&raw); err != nil {
		writeJSON(w, 200, workspaceState{Page: "dashboard"})
		return
	}
	value := workspaceState{}
	_ = json.Unmarshal(raw, &value)
	writeJSON(w, 200, normalizeWorkspaceState(value))
}

func (a *app) saveWorkspaceState(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	value := workspaceState{}
	if !decodeJSON(w, r, &value) {
		return
	}
	value = normalizeWorkspaceState(value)
	raw, _ := json.Marshal(value)
	_, err := a.db.ExecContext(r.Context(), `
		INSERT INTO user_workspace_state(user_id,state,updated_at) VALUES($1,$2,now())
		ON CONFLICT(user_id) DO UPDATE
		SET state=COALESCE(user_workspace_state.state,'{}'::jsonb) || $2::jsonb,updated_at=now()`, user.ID, raw)
	if err != nil {
		fail(w, 500, "Не удалось сохранить рабочее место")
		return
	}
	writeJSON(w, 200, value)
}
