package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type authUser struct {
	ID          int64         `json:"id"`
	Name        string        `json:"name"`
	Email       string        `json:"email"`
	Role        string        `json:"role"`
	Permissions permissionSet `json:"permissions"`
	IsDeveloper bool          `json:"is_developer"`
}

type contextKey string

const (
	userKey              contextKey = "auth-user"
	desktopTokenAudience            = "desktop-notifications"
)

type loginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

var errInvalidCredentials = errors.New("invalid credentials")

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	var input loginInput
	if !decodeJSON(w, r, &input) {
		return
	}
	user, err := a.authenticateCredentials(r.Context(), input)
	if errors.Is(err, errInvalidCredentials) {
		fail(w, http.StatusUnauthorized, "Неверная почта или пароль")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}

	claims := jwt.MapClaims{
		"sub": strconv.FormatInt(user.ID, 10), "name": user.Name, "email": user.Email,
		"role": user.Role, "exp": time.Now().Add(12 * time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	token, err := a.signToken(claims)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Ошибка входа")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}

func (a *app) authenticateCredentials(ctx context.Context, input loginInput) (authUser, error) {
	var user authUser
	var hash string
	var active bool
	err := a.db.QueryRowContext(ctx, `SELECT id,name,email,password_hash,role,active FROM users WHERE email=lower($1)`, strings.TrimSpace(input.Email)).Scan(&user.ID, &user.Name, &user.Email, &hash, &user.Role, &active)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil || !active) {
		return authUser{}, errInvalidCredentials
	}
	if err != nil {
		return authUser{}, err
	}
	return a.loadAuthUser(ctx, user.ID)
}

func (a *app) signToken(claims jwt.MapClaims) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.jwtSecret)
}

func (a *app) authorize(next http.Handler) http.Handler {
	return a.authorizeAudience("", next)
}

func (a *app) authorizeDesktop(next http.Handler) http.Handler {
	return a.authorizeAudience(desktopTokenAudience, next)
}

func (a *app) authorizeAudience(expectedAudience string, next http.Handler) http.Handler {
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
		if !ok || !tokenAudienceAllowed(claims, expectedAudience) {
			fail(w, http.StatusUnauthorized, "Некорректная сессия")
			return
		}
		subject, ok := claims["sub"].(string)
		if !ok {
			fail(w, http.StatusUnauthorized, "Некорректная сессия")
			return
		}
		id, err := strconv.ParseInt(subject, 10, 64)
		if err != nil {
			fail(w, http.StatusUnauthorized, "Некорректная сессия")
			return
		}
		user, err := a.loadAuthUser(r.Context(), id)
		if err != nil {
			fail(w, http.StatusUnauthorized, "Сессия недействительна")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	})
}

func tokenAudienceAllowed(claims jwt.MapClaims, expected string) bool {
	audience, err := claims.GetAudience()
	if err != nil {
		return false
	}
	if expected == "" {
		return len(audience) == 0
	}
	return len(audience) == 1 && audience[0] == expected
}

func currentUser(r *http.Request) authUser               { return r.Context().Value(userKey).(authUser) }
func (a *app) me(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, currentUser(r)) }
