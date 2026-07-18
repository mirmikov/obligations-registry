package main

import (
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,email,role,active,to_char(created_at,'YYYY-MM-DD') FROM users ORDER BY id`)
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
		if rows.Scan(&id, &name, &email, &role, &active, &created) == nil {
			items = append(items, map[string]any{"id": id, "name": name, "email": email, "role": role, "active": active, "created_at": created})
		}
	}
	writeJSON(w, 200, items)
}

func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name, Email, Password, Role string
		Active                      *bool
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !validRole(input.Role) || len(input.Password) < 8 {
		fail(w, 400, "Укажите роль и пароль не короче 8 символов")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	var id int64
	err := a.db.QueryRowContext(r.Context(), `INSERT INTO users(name,email,password_hash,role) VALUES($1,lower($2),$3,$4) RETURNING id`, strings.TrimSpace(input.Name), strings.TrimSpace(input.Email), string(hash), input.Role).Scan(&id)
	if err != nil {
		fail(w, 400, "Пользователь с такой почтой уже существует")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "create", "user", &id, map[string]any{"email": input.Email, "role": input.Role})
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
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !validRole(input.Role) {
		fail(w, 400, "Некорректная роль")
		return
	}
	if input.Password != "" {
		if len(input.Password) < 8 {
			fail(w, 400, "Пароль должен быть не короче 8 символов")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
		_, err = a.db.ExecContext(r.Context(), `UPDATE users SET name=$1,role=$2,active=COALESCE($3,active),password_hash=$4,updated_at=now() WHERE id=$5`, input.Name, input.Role, input.Active, string(hash), id)
	} else {
		_, err = a.db.ExecContext(r.Context(), `UPDATE users SET name=$1,role=$2,active=COALESCE($3,active),updated_at=now() WHERE id=$4`, input.Name, input.Role, input.Active, id)
	}
	if err != nil {
		fail(w, 400, "Не удалось обновить пользователя")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "update", "user", &id, map[string]any{"role": input.Role, "active": input.Active})
	writeJSON(w, 200, map[string]any{"id": id})
}

func validRole(role string) bool { return role == "admin" || role == "editor" || role == "viewer" }

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
