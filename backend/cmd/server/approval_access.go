package main

import (
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

type obligationApprovalState struct {
	ApprovalDate string `json:"approval_date"`
	Status       string `json:"status"`
}

func isManager(user authUser) bool {
	return user.Role == managerRole || user.IsDeveloper
}

func validateApprovalCreate(user authUser, input obligationInput) error {
	if isManager(user) {
		return nil
	}
	if strings.TrimSpace(input.ApprovalDate) != "" || strings.TrimSpace(input.Status) == payableStatus {
		return errManagerApprovalRequired
	}
	return nil
}

func validateApprovalUpdate(user authUser, previous obligationApprovalState, next obligationInput) error {
	if isManager(user) {
		return nil
	}
	if strings.TrimSpace(previous.ApprovalDate) != strings.TrimSpace(next.ApprovalDate) {
		return errManagerApprovalRequired
	}
	if strings.TrimSpace(previous.Status) != payableStatus && strings.TrimSpace(next.Status) == payableStatus {
		return errManagerApprovalRequired
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

func (a *app) requireManager(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isManager(currentUser(r)) {
			fail(w, http.StatusForbidden, errManagerApprovalRequired.Error())
			return
		}
		next.ServeHTTP(w, r)
	})
}
