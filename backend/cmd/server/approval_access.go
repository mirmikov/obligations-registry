package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const (
	managerRole   = "manager"
	payableStatus = "К оплате"
)

var errManagerApprovalRequired = errors.New("статус «К оплате» и дату утверждения может изменять только руководитель или программист")

type approvalLegalEntityError struct{ LegalEntity string }

func (value approvalLegalEntityError) Error() string {
	if strings.TrimSpace(value.LegalEntity) == "" {
		return "для утверждения платежа выберите юридическое лицо, разрешённое в настройках пользователя"
	}
	return "нет права утверждать платежи юридического лица «" + strings.TrimSpace(value.LegalEntity) + "»"
}

type obligationApprovalState struct {
	ApprovalDate string `json:"approval_date"`
	LegalEntity  string `json:"legal_entity"`
	Status       string `json:"status"`
}

func isManager(user authUser) bool {
	return user.IsDeveloper || user.Role == managerRole && user.Permissions["obligations.approve"]
}

func canApproveLegalEntity(user authUser, legalEntity string) bool {
	if !isManager(user) {
		return false
	}
	if user.IsDeveloper || len(user.ApprovalLegalEntities) == 0 {
		return true
	}
	legalEntity = strings.TrimSpace(legalEntity)
	for _, allowed := range user.ApprovalLegalEntities {
		if strings.EqualFold(strings.TrimSpace(allowed), legalEntity) {
			return true
		}
	}
	return false
}

func approvalChangeRequested(previous obligationApprovalState, next obligationInput) bool {
	entityChanged := !strings.EqualFold(strings.TrimSpace(previous.LegalEntity), strings.TrimSpace(next.LegalEntity))
	approvedAfterChange := strings.TrimSpace(next.ApprovalDate) != "" || strings.TrimSpace(next.Status) == payableStatus
	return entityChanged && approvedAfterChange || strings.TrimSpace(previous.ApprovalDate) != strings.TrimSpace(next.ApprovalDate) ||
		strings.TrimSpace(previous.Status) != payableStatus && strings.TrimSpace(next.Status) == payableStatus
}

func validateApprovalCreate(user authUser, input obligationInput) error {
	if strings.TrimSpace(input.ApprovalDate) == "" && strings.TrimSpace(input.Status) != payableStatus {
		return nil
	}
	if !isManager(user) {
		return errManagerApprovalRequired
	}
	if !canApproveLegalEntity(user, input.LegalEntity) {
		return approvalLegalEntityError{LegalEntity: input.LegalEntity}
	}
	return nil
}

func validateApprovalUpdate(user authUser, previous obligationApprovalState, next obligationInput) error {
	if !approvalChangeRequested(previous, next) {
		return nil
	}
	if !isManager(user) {
		return errManagerApprovalRequired
	}
	if !canApproveLegalEntity(user, next.LegalEntity) {
		return approvalLegalEntityError{LegalEntity: next.LegalEntity}
	}
	return nil
}

func approvalStateFromSnapshot(raw json.RawMessage) (obligationApprovalState, error) {
	var value obligationApprovalState
	err := json.Unmarshal(raw, &value)
	return value, err
}

func validateApprovalBulk(user authUser, input bulkUpdateInput) error {
	if isManager(user) {
		return nil
	}
	if input.ApprovalDateSet || strings.TrimSpace(input.ApprovalDate) != "" || strings.TrimSpace(input.Status) == payableStatus {
		return errManagerApprovalRequired
	}
	return nil
}

func approvalBulkUpdateRequested(input bulkUpdateInput) bool {
	return input.ApprovalDateSet || strings.TrimSpace(input.ApprovalDate) != "" || strings.TrimSpace(input.Status) == payableStatus
}

func validateApprovalLegalEntitiesForIDs(ctx context.Context, tx *sql.Tx, user authUser, ids []int64) error {
	if user.IsDeveloper || len(user.ApprovalLegalEntities) == 0 || len(ids) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT COALESCE(legal_entity,'') FROM obligations WHERE id=ANY($1) ORDER BY 1`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var legalEntity string
		if err = rows.Scan(&legalEntity); err != nil {
			return err
		}
		if !canApproveLegalEntity(user, legalEntity) {
			return approvalLegalEntityError{LegalEntity: legalEntity}
		}
	}
	return rows.Err()
}

func (a *app) requireManager(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isManager(currentUser(r)) {
			fail(w, http.StatusForbidden, errManagerApprovalRequired.Error())
			return
		}
		next.ServeHTTP(w, r)
	})
}
