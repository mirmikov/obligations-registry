package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type authUser struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

type contextKey string

const userKey contextKey = "auth-user"

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var input struct{ Email, Password string }
	if !decodeJSON(w, r, &input) {
		return
	}
	var user authUser
	var hash string
	var active bool
	err := a.db.QueryRowContext(r.Context(), `SELECT id,name,email,password_hash,role,active FROM users WHERE email=lower($1)`, strings.TrimSpace(input.Email)).Scan(&user.ID, &user.Name, &user.Email, &hash, &user.Role, &active)
	if err == sql.ErrNoRows || bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil || !active {
		fail(w, http.StatusUnauthorized, "Неверная почта или пароль")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}

	claims := jwt.MapClaims{"sub": strconv.FormatInt(user.ID, 10), "name": user.Name, "email": user.Email, "role": user.Role, "exp": time.Now().Add(12 * time.Hour).Unix(), "iat": time.Now().Unix()}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.jwtSecret)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}

func (a *app) authorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if header == "" {
			fail(w, http.StatusUnauthorized, "Требуется вход")
			return
		}
		token, err := jwt.Parse(header, func(token *jwt.Token) (any, error) { return a.jwtSecret, nil }, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
		if err != nil || !token.Valid {
			fail(w, http.StatusUnauthorized, "Сессия истекла")
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			fail(w, http.StatusUnauthorized, "Некорректная сессия")
			return
		}
		id, err := strconv.ParseInt(claims["sub"].(string), 10, 64)
		if err != nil {
			fail(w, http.StatusUnauthorized, "Некорректная сессия")
			return
		}
		user := authUser{ID: id, Name: stringClaim(claims, "name"), Email: stringClaim(claims, "email"), Role: stringClaim(claims, "role")}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

func stringClaim(claims jwt.MapClaims, key string) string {
	value, _ := claims[key].(string)
	return value
}
func currentUser(r *http.Request) authUser               { return r.Context().Value(userKey).(authUser) }
func (a *app) me(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, currentUser(r)) }

func (a *app) requireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowed[currentUser(r).Role] {
				fail(w, http.StatusForbidden, "Недостаточно прав")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
