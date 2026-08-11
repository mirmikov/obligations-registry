package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const developerEmail = "mirmikov@mirt-med.ru"

type permissionSet map[string]bool

type permissionItem struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type permissionGroup struct {
	Key         string           `json:"key"`
	Label       string           `json:"label"`
	Permissions []permissionItem `json:"permissions"`
}

var permissionCatalog = []permissionGroup{
	{Key: "dashboard", Label: "Общая сводка", Permissions: []permissionItem{{Key: "dashboard.view", Label: "Просмотр"}}},
	{Key: "my_invoices", Label: "Мои счета", Permissions: []permissionItem{{Key: "my_invoices.view", Label: "Просмотр собственных счетов"}}},
	{Key: "executive", Label: "Панель руководителя", Permissions: []permissionItem{{Key: "executive.view", Label: "Просмотр"}, {Key: "executive.approve", Label: "Изменение статуса и даты утверждения"}, {Key: "executive.settings", Label: "Настройка специальных разделов"}}},
	{Key: "registry", Label: "Реестр", Permissions: []permissionItem{{Key: "registry.view", Label: "Просмотр"}, {Key: "registry.create", Label: "Добавление строк"}, {Key: "registry.edit", Label: "Редактирование"}, {Key: "registry.delete", Label: "Удаление строк"}, {Key: "registry.split", Label: "Разбиение платежа"}, {Key: "registry.ai_scan", Label: "AI сканирование"}, {Key: "registry.import", Label: "Импорт Excel"}, {Key: "registry.export", Label: "Выгрузка Excel"}, {Key: "registry.undo", Label: "Отмена действий"}}},
	{Key: "credits", Label: "Кредиты и лизинги", Permissions: []permissionItem{{Key: "credits.view", Label: "Просмотр"}, {Key: "credits.approve", Label: "Изменение статуса и даты утверждения"}}},
	{Key: "payments", Label: "К оплате", Permissions: []permissionItem{{Key: "payments.view", Label: "Просмотр"}, {Key: "payments.edit", Label: "Редактирование статуса и фактической даты"}, {Key: "payments.print", Label: "Печать"}}},
	{Key: "invoice_mail", Label: "Счета в бухгалтерию", Permissions: []permissionItem{{Key: "invoice_mail.send", Label: "Отправка счетов"}, {Key: "invoice_mail.inbox", Label: "Получение и обработка счетов бухгалтерией"}}},
	{Key: "chat", Label: "Чаты", Permissions: []permissionItem{{Key: "chat.view", Label: "Просмотр"}, {Key: "chat.send", Label: "Отправка сообщений"}, {Key: "chat.create", Label: "Создание личных чатов и групп"}}},
	{Key: "references", Label: "Справочники", Permissions: []permissionItem{{Key: "references.view", Label: "Просмотр"}, {Key: "references.edit", Label: "Добавление, объединение и удаление значений"}}},
	{Key: "users", Label: "Пользователи", Permissions: []permissionItem{{Key: "users.view", Label: "Просмотр"}, {Key: "users.manage", Label: "Создание и редактирование пользователей"}}},
	{Key: "audit", Label: "Журнал действий", Permissions: []permissionItem{{Key: "audit.view", Label: "Просмотр"}}},
}

func allPermissionKeys() map[string]bool {
	keys := map[string]bool{}
	for _, group := range permissionCatalog {
		for _, item := range group.Permissions {
			keys[item.Key] = true
		}
	}
	return keys
}

func defaultPermissions(role string) permissionSet {
	baseRole := role
	if role == "accountant" {
		baseRole = "editor"
	}
	value := permissionSet{
		"dashboard.view": true, "my_invoices.view": true, "registry.view": true, "registry.export": true,
		"credits.view": true, "payments.view": true, "payments.print": true,
		"chat.view": true, "chat.send": true, "chat.create": true, "invoice_mail.send": true,
	}
	if baseRole == "editor" || baseRole == "admin" {
		for _, key := range []string{"registry.create", "registry.edit", "registry.delete", "registry.split", "registry.ai_scan", "registry.undo", "credits.approve", "payments.edit", "references.view", "references.edit"} {
			value[key] = true
		}
	}
	if baseRole == "admin" {
		for _, key := range []string{"executive.view", "executive.approve", "executive.settings", "registry.import", "users.view", "users.manage", "audit.view"} {
			value[key] = true
		}
	}
	if role == "accountant" {
		value["invoice_mail.inbox"] = true
	}
	return value
}

func normalizePermissions(input permissionSet, role string) permissionSet {
	if input == nil {
		return defaultPermissions(role)
	}
	keys := allPermissionKeys()
	value := permissionSet{}
	for key, enabled := range input {
		if keys[key] {
			value[key] = enabled
		}
	}
	if role != "accountant" {
		delete(value, "invoice_mail.inbox")
	}
	for child, parent := range map[string]string{
		"executive.approve": "executive.view", "executive.settings": "executive.view",
		"registry.create": "registry.view", "registry.edit": "registry.view", "registry.delete": "registry.view", "registry.ai_scan": "registry.view",
		"registry.split": "registry.view", "registry.import": "registry.view", "registry.export": "registry.view", "registry.undo": "registry.view",
		"credits.view": "registry.view", "credits.approve": "credits.view", "payments.edit": "payments.view", "payments.print": "payments.view",
		"chat.send": "chat.view", "chat.create": "chat.view", "invoice_mail.send": "chat.view", "invoice_mail.inbox": "chat.view", "references.edit": "references.view", "users.manage": "users.view",
	} {
		if value[child] {
			value[parent] = true
		}
	}
	if value["invoice_mail.inbox"] {
		value["chat.send"] = true
		value["chat.view"] = true
	}
	return value
}

func fullPermissions() permissionSet {
	value := permissionSet{}
	for key := range allPermissionKeys() {
		value[key] = true
	}
	return value
}

func isDeveloperEmail(email string) bool {
	return strings.EqualFold(strings.TrimSpace(email), developerEmail)
}

func profileRoleFromState(raw []byte, fallback string) string {
	var state struct {
		ProfileRole string `json:"profile_role"`
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &state)
	}
	if state.ProfileRole == "accountant" && fallback == "editor" {
		return "accountant"
	}
	return fallback
}

func saveUserProfileRole(ctx context.Context, tx *sql.Tx, userID int64, role string) error {
	if role == "accountant" {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO user_workspace_state(user_id,state,updated_at)
			VALUES($1,jsonb_build_object('profile_role','accountant'),now())
			ON CONFLICT(user_id) DO UPDATE
			SET state=jsonb_set(COALESCE(user_workspace_state.state,'{}'::jsonb),'{profile_role}','"accountant"'::jsonb,true),updated_at=now()`, userID)
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE user_workspace_state SET state=state-'profile_role',updated_at=now() WHERE user_id=$1`, userID)
	return err
}

func permissionsFromState(raw []byte, role string) permissionSet {
	var state struct {
		Permissions permissionSet `json:"permissions"`
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &state)
	}
	if state.Permissions != nil {
		if _, exists := state.Permissions["my_invoices.view"]; !exists {
			state.Permissions["my_invoices.view"] = true
		}
		if _, exists := state.Permissions["invoice_mail.send"]; !exists {
			state.Permissions["invoice_mail.send"] = true
		}
	}
	return normalizePermissions(state.Permissions, role)
}

func (a *app) loadAuthUser(ctx context.Context, id int64) (authUser, error) {
	var user authUser
	var raw []byte
	err := a.db.QueryRowContext(ctx, `
		SELECT u.id,u.name,u.email,u.role,COALESCE(s.state,'{}'::jsonb)
		FROM users u LEFT JOIN user_workspace_state s ON s.user_id=u.id
		WHERE u.id=$1 AND u.active=true`, id).Scan(&user.ID, &user.Name, &user.Email, &user.Role, &raw)
	if err != nil {
		return authUser{}, err
	}
	user.IsDeveloper = isDeveloperEmail(user.Email)
	if user.IsDeveloper {
		user.Role = "developer"
		user.Permissions = fullPermissions()
	} else {
		user.Role = profileRoleFromState(raw, user.Role)
		user.Permissions = permissionsFromState(raw, user.Role)
	}
	return user, nil
}

func (a *app) requirePermission(permission string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := currentUser(r)
			if !user.IsDeveloper && !user.Permissions[permission] {
				fail(w, http.StatusForbidden, "Недостаточно прав")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (a *app) requireDeveloper(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).IsDeveloper {
			fail(w, http.StatusForbidden, "Настройка доступна только программисту")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) permissionCatalogHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"groups": permissionCatalog,
		"presets": map[string]permissionSet{
			"admin": defaultPermissions("admin"), "accountant": defaultPermissions("accountant"), "editor": defaultPermissions("editor"), "viewer": defaultPermissions("viewer"),
		},
	})
}

type maintenanceState struct {
	Active    bool   `json:"active"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updated_at,omitempty"`
	UpdatedBy string `json:"updated_by,omitempty"`
}

func (a *app) readMaintenanceState(ctx context.Context) maintenanceState {
	value := maintenanceState{Message: "Ведется обновление программы"}
	var raw []byte
	err := a.db.QueryRowContext(ctx, `
		SELECT COALESCE(s.state->'system_maintenance','{}'::jsonb)
		FROM users u LEFT JOIN user_workspace_state s ON s.user_id=u.id
		WHERE lower(u.email)=$1`, developerEmail).Scan(&raw)
	if err == nil {
		_ = json.Unmarshal(raw, &value)
	}
	if strings.TrimSpace(value.Message) == "" {
		value.Message = "Ведется обновление программы"
	}
	return value
}

func (a *app) getSystemStatus(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	writeJSON(w, http.StatusOK, systemStatusPayload(user, a.readMaintenanceState(r.Context()), time.Now()))
}

func systemStatusPayload(user authUser, maintenance maintenanceState, now time.Time) map[string]any {
	value := map[string]any{"maintenance": maintenance}
	if user.IsDeveloper {
		value["backup"] = readBackupStatus(now)
	}
	return value
}

func (a *app) updateMaintenance(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Active bool `json:"active"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user := currentUser(r)
	value := maintenanceState{Active: input.Active, Message: "Ведется обновление программы", UpdatedAt: time.Now().Format(time.RFC3339), UpdatedBy: user.Name}
	raw, _ := json.Marshal(value)
	_, err := a.db.ExecContext(r.Context(), `
		INSERT INTO user_workspace_state(user_id,state,updated_at) VALUES($1,jsonb_build_object('system_maintenance',$2::jsonb),now())
		ON CONFLICT(user_id) DO UPDATE SET state=jsonb_set(COALESCE(user_workspace_state.state,'{}'::jsonb),'{system_maintenance}',$2::jsonb,true),updated_at=now()`,
		user.ID, raw)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось изменить режим обновления")
		return
	}
	a.audit(r.Context(), user.ID, "update", "system_maintenance", nil, map[string]any{"active": input.Active})
	writeJSON(w, http.StatusOK, map[string]any{"maintenance": value})
}

func saveUserPermissions(ctx context.Context, tx *sql.Tx, userID int64, permissions permissionSet) error {
	raw, _ := json.Marshal(permissions)
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_workspace_state(user_id,state,updated_at) VALUES($1,jsonb_build_object('permissions',$2::jsonb),now())
		ON CONFLICT(user_id) DO UPDATE SET state=jsonb_set(COALESCE(user_workspace_state.state,'{}'::jsonb),'{permissions}',$2::jsonb,true),updated_at=now()`,
		userID, raw)
	return err
}
