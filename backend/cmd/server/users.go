package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT u.id,u.name,u.email,u.role,u.active,to_char(u.created_at,'YYYY-MM-DD'),COALESCE(s.state,'{}'::jsonb)
		FROM users u LEFT JOIN user_workspace_state s ON s.user_id=u.id ORDER BY u.id`)
	if err != nil {
		fail(w, 500, "Не удалось загрузить пользователей")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, email, role, created string
		var active bool
		var raw []byte
		if rows.Scan(&id, &name, &email, &role, &active, &created, &raw) == nil {
			developer := isDeveloperEmail(email)
			displayRole := profileRoleFromState(raw, role)
			permissions := permissionsFromState(raw, displayRole)
			if developer {
				displayRole = "developer"
				permissions = fullPermissions()
			}
			items = append(items, map[string]any{"id": id, "name": name, "email": email, "role": displayRole, "active": active, "created_at": created, "permissions": permissions, "is_developer": developer})
		}
	}
	writeJSON(w, 200, items)
}

func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name, Email, Password, Role string
		Active                      *bool
		Permissions                 *permissionSet
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	requestedRole := input.Role
	user := currentUser(r)
	if !validRole(requestedRole) || len(input.Password) < 8 {
		fail(w, 400, "Укажите роль и пароль не короче 8 символов")
		return
	}
	if protectedProfileRole(requestedRole) && !user.IsDeveloper {
		fail(w, http.StatusForbidden, "Роли бухгалтера и руководителя может назначать только программист")
		return
	}
	if input.Permissions != nil && !user.IsDeveloper {
		fail(w, http.StatusForbidden, "Права может настраивать только программист")
		return
	}
	if isDeveloperEmail(input.Email) {
		requestedRole = "admin"
	}
	storedRole := storedDatabaseRole(requestedRole)
	hash, _ := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	if err = lockAccountingMailboxRouting(r.Context(), tx); err != nil {
		fail(w, 500, "Не удалось зафиксировать настройки бухгалтерии")
		return
	}
	var id int64
	err = tx.QueryRowContext(r.Context(), `INSERT INTO users(name,email,password_hash,role) VALUES($1,lower($2),$3,$4) RETURNING id`, strings.TrimSpace(input.Name), strings.TrimSpace(input.Email), string(hash), storedRole).Scan(&id)
	if err != nil {
		fail(w, 400, "Пользователь с такой почтой уже существует")
		return
	}
	if err = saveUserProfileRole(r.Context(), tx, id, requestedRole); err != nil {
		fail(w, 500, "Не удалось сохранить роль пользователя")
		return
	}
	effectivePermissions := defaultPermissions(requestedRole)
	if input.Permissions != nil {
		effectivePermissions = normalizePermissions(*input.Permissions, requestedRole)
	}
	if input.Permissions != nil || protectedProfileRole(requestedRole) {
		if err = saveUserPermissions(r.Context(), tx, id, effectivePermissions); err != nil {
			fail(w, 500, "Не удалось сохранить права пользователя")
			return
		}
	}
	if canReceiveAccountingMail(requestedRole, true, effectivePermissions) {
		if err = syncAccountingMemberships(r.Context(), tx, id, true); err != nil {
			fail(w, 500, "Не удалось подключить почту бухгалтерии")
			return
		}
	}
	after, err := snapshotRows(r.Context(), tx, "users", []int64{id})
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	afterAccess, err := snapshotRows(r.Context(), tx, "user_access", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "create", "Создание пользователя «"+strings.TrimSpace(input.Name)+"»", undoPayload{Users: &undoChange{Before: emptySnapshot(), After: after}, UserAccess: &undoChange{Before: emptySnapshot(), After: afterAccess}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "create", "user", &id, map[string]any{"email": input.Email, "role": requestedRole})
	writeJSON(w, 201, map[string]any{"id": id})
}

func (a *app) updateUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "Некорректный ID")
		return
	}
	var input struct {
		Name, Role, Password string
		Active               *bool
		Permissions          *permissionSet
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	requestedRole := input.Role
	if requestedRole == "developer" {
		requestedRole = "admin"
	}
	if !validRole(requestedRole) {
		fail(w, 400, "Некорректная роль")
		return
	}
	user := currentUser(r)
	if protectedProfileRole(requestedRole) && !user.IsDeveloper {
		fail(w, http.StatusForbidden, "Роли бухгалтера и руководителя может назначать только программист")
		return
	}
	if input.Permissions != nil && !user.IsDeveloper {
		fail(w, http.StatusForbidden, "Права может настраивать только программист")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	if err = lockAccountingMailboxRouting(r.Context(), tx); err != nil {
		fail(w, 500, "Не удалось зафиксировать настройки бухгалтерии")
		return
	}
	var targetEmail string
	var targetStoredRole string
	var targetActive bool
	var targetState []byte
	if err = tx.QueryRowContext(r.Context(), `
		SELECT u.id,u.email,u.role,u.active,COALESCE((SELECT state FROM user_workspace_state WHERE user_id=u.id),'{}'::jsonb)
		FROM users u WHERE u.id=$1 FOR UPDATE`, id).Scan(&id, &targetEmail, &targetStoredRole, &targetActive, &targetState); err == sql.ErrNoRows {
		fail(w, 404, "Пользователь не найден")
		return
	} else if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	targetDeveloper := isDeveloperEmail(targetEmail)
	if targetDeveloper {
		requestedRole = "admin"
		active := true
		input.Active = &active
		input.Permissions = nil
	}
	currentProfileRole := profileRoleFromState(targetState, targetStoredRole)
	if protectedProfileRole(currentProfileRole) && !user.IsDeveloper {
		fail(w, http.StatusForbidden, "Роли бухгалтера и руководителя может изменять только программист")
		return
	}
	if input.Active != nil {
		targetActive = *input.Active
	}
	storedRole := storedDatabaseRole(requestedRole)
	before, err := snapshotRows(r.Context(), tx, "users", []int64{id})
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	beforeAccess, err := snapshotRows(r.Context(), tx, "user_access", []int64{id})
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю прав пользователя")
		return
	}
	if err = saveUserProfileRole(r.Context(), tx, id, requestedRole); err != nil {
		fail(w, 500, "Не удалось сохранить роль пользователя")
		return
	}
	effectivePermissions := permissionsFromState(targetState, requestedRole)
	savePermissions := false
	if input.Permissions != nil {
		effectivePermissions = normalizePermissions(*input.Permissions, requestedRole)
		savePermissions = true
	} else if protectedProfileRole(requestedRole) && currentProfileRole != requestedRole {
		effectivePermissions = defaultPermissions(requestedRole)
		savePermissions = true
	} else if requestedRole != currentProfileRole && protectedProfileRole(currentProfileRole) {
		savePermissions = true
	}
	if savePermissions {
		if err = saveUserPermissions(r.Context(), tx, id, effectivePermissions); err != nil {
			fail(w, 500, "Не удалось сохранить права пользователя")
			return
		}
	}
	if err = syncAccountingMemberships(r.Context(), tx, id, canReceiveAccountingMail(requestedRole, targetActive, effectivePermissions)); err != nil {
		if canReceiveAccountingMail(requestedRole, targetActive, effectivePermissions) {
			fail(w, 500, "Не удалось подключить почту бухгалтерии")
		} else {
			fail(w, 500, "Не удалось сохранить историю почты бухгалтерии")
		}
		return
	}
	if input.Password != "" {
		if len(input.Password) < 8 {
			fail(w, 400, "Пароль должен быть не короче 8 символов")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
		_, err = tx.ExecContext(r.Context(), `UPDATE users SET name=$1,role=$2,active=COALESCE($3,active),password_hash=$4,updated_at=now() WHERE id=$5`, input.Name, storedRole, input.Active, string(hash), id)
	} else {
		_, err = tx.ExecContext(r.Context(), `UPDATE users SET name=$1,role=$2,active=COALESCE($3,active),updated_at=now() WHERE id=$4`, input.Name, storedRole, input.Active, id)
	}
	if err != nil {
		fail(w, 400, "Не удалось обновить пользователя")
		return
	}
	after, err := snapshotRows(r.Context(), tx, "users", []int64{id})
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	afterAccess, err := snapshotRows(r.Context(), tx, "user_access", []int64{id})
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "update", fmt.Sprintf("Изменение пользователя №%d", id), undoPayload{Users: &undoChange{Before: before, After: after}, UserAccess: &undoChange{Before: beforeAccess, After: afterAccess}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить сохранение")
		return
	}
	a.audit(r.Context(), user.ID, "update", "user", &id, map[string]any{"role": requestedRole, "active": input.Active})
	writeJSON(w, 200, map[string]any{"id": id})
}

func validRole(role string) bool {
	return role == "admin" || role == managerRole || role == "accountant" || role == "editor" || role == "viewer"
}

func protectedProfileRole(role string) bool {
	return role == "accountant" || role == managerRole
}

func storedDatabaseRole(role string) string {
	if role == "accountant" {
		return "editor"
	}
	if role == managerRole {
		return "viewer"
	}
	return role
}

func (a *app) auditLog(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT a.id,COALESCE(u.name,'Система'),a.action,a.entity_type,a.entity_id,a.details,to_char(a.created_at,'YYYY-MM-DD HH24:MI:SS') FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500`)
	if err != nil {
		fail(w, 500, "Не удалось загрузить журнал")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var user, action, entity string
		var entityID *int64
		var details []byte
		var created string
		if rows.Scan(&id, &user, &action, &entity, &entityID, &details, &created) == nil {
			items = append(items, map[string]any{"id": id, "user": user, "action": action, "entity_type": entity, "entity_id": entityID, "details": string(details), "created_at": created})
		}
	}
	writeJSON(w, 200, items)
}
