package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations.sql seed/registry.json
var assets embed.FS

type app struct {
	db        *sql.DB
	jwtSecret []byte
	presence  *presenceHub
}

func main() {
	databaseURL := getenv("DATABASE_URL", "postgres://registry:registry@localhost:5432/registry?sslmode=disable")
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for {
		if err = db.PingContext(ctx); err == nil {
			break
		}
		if ctx.Err() != nil {
			log.Fatalf("database is unavailable: %v", err)
		}
		log.Printf("waiting for database: %v", err)
		time.Sleep(2 * time.Second)
	}

	a := &app{db: db, jwtSecret: []byte(getenv("JWT_SECRET", "change-me-in-production")), presence: newPresenceHub()}
	if databaseMigrationsEnabled() {
		if err := a.migrateAndSeed(context.Background()); err != nil {
			log.Fatal(err)
		}
	} else {
		log.Print("database migrations and seed are disabled")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.Handle("GET /api/auth/me", a.authorize(http.HandlerFunc(a.me)))
	mux.Handle("GET /api/presence", a.authorize(http.HandlerFunc(a.listPresence)))
	mux.Handle("POST /api/presence", a.authorize(http.HandlerFunc(a.updatePresence)))
	mux.Handle("DELETE /api/presence/{session}", a.authorize(http.HandlerFunc(a.removePresence)))
	mux.Handle("GET /api/chat/users", a.authorize(http.HandlerFunc(a.listChatUsers)))
	mux.Handle("GET /api/chat/conversations", a.authorize(http.HandlerFunc(a.listChatConversations)))
	mux.Handle("POST /api/chat/direct", a.authorize(http.HandlerFunc(a.createDirectChat)))
	mux.Handle("POST /api/chat/groups", a.authorize(http.HandlerFunc(a.createGroupChat)))
	mux.Handle("GET /api/chat/conversations/{id}/messages", a.authorize(http.HandlerFunc(a.listChatMessages)))
	mux.Handle("POST /api/chat/conversations/{id}/messages", a.authorize(http.HandlerFunc(a.sendChatMessage)))
	mux.Handle("GET /api/chat/conversations/{id}/images/{name}", a.authorize(http.HandlerFunc(a.serveChatImage)))
	mux.Handle("POST /api/chat/conversations/{id}/read", a.authorize(http.HandlerFunc(a.markChatRead)))
	mux.Handle("GET /api/obligations", a.authorize(http.HandlerFunc(a.listObligations)))
	mux.Handle("POST /api/obligations", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.createObligation))))
	mux.Handle("PATCH /api/obligations/{id}", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.updateObligation))))
	mux.Handle("DELETE /api/obligations/{id}", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.deleteObligation))))
	mux.Handle("POST /api/obligations/bulk", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.bulkUpdate))))
	mux.Handle("POST /api/obligations/{id}/split", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.splitObligation))))
	mux.Handle("GET /api/obligations/export.xlsx", a.authorize(http.HandlerFunc(a.exportXLSX)))
	mux.Handle("POST /api/obligations/import.xlsx", a.authorize(a.requireRole("admin")(http.HandlerFunc(a.importXLSX))))
	mux.Handle("GET /api/undo", a.authorize(http.HandlerFunc(a.undoStatus)))
	mux.Handle("POST /api/undo", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.undoLast))))
	mux.Handle("GET /api/references", a.authorize(http.HandlerFunc(a.listReferences)))
	mux.Handle("POST /api/references/{kind}", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.addReference))))
	mux.Handle("DELETE /api/references/{kind}/{id}", a.authorize(a.requireRole("admin", "editor")(http.HandlerFunc(a.deleteReference))))
	mux.Handle("GET /api/dashboard", a.authorize(http.HandlerFunc(a.dashboard)))
	mux.Handle("GET /api/reports/credits-leasing", a.authorize(http.HandlerFunc(a.creditsLeasingReport)))
	mux.Handle("GET /api/payment-register", a.authorize(http.HandlerFunc(a.paymentRegister)))
	mux.Handle("GET /api/saved-view", a.authorize(http.HandlerFunc(a.getSavedView)))
	mux.Handle("PUT /api/saved-view", a.authorize(http.HandlerFunc(a.saveView)))
	mux.Handle("GET /api/workspace-state", a.authorize(http.HandlerFunc(a.getWorkspaceState)))
	mux.Handle("PUT /api/workspace-state", a.authorize(http.HandlerFunc(a.saveWorkspaceState)))
	mux.Handle("GET /api/users", a.authorize(a.requireRole("admin")(http.HandlerFunc(a.listUsers))))
	mux.Handle("POST /api/users", a.authorize(a.requireRole("admin")(http.HandlerFunc(a.createUser))))
	mux.Handle("PATCH /api/users/{id}", a.authorize(a.requireRole("admin")(http.HandlerFunc(a.updateUser))))
	mux.Handle("GET /api/audit", a.authorize(a.requireRole("admin")(http.HandlerFunc(a.auditLog))))

	server := &http.Server{
		Addr:              ":" + getenv("PORT", "8080"),
		Handler:           requestLogger(cors(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	go func() {
		log.Printf("API listening on %s", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	shutdown, done := context.WithTimeout(context.Background(), 15*time.Second)
	defer done()
	_ = server.Shutdown(shutdown)
}

func databaseMigrationsEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(getenv("RUN_DATABASE_MIGRATIONS", "true")))
	return value != "false" && value != "0" && value != "no" && value != "off"
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	if err := a.db.PingContext(r.Context()); err != nil {
		fail(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		fail(w, http.StatusBadRequest, "Некорректные данные: "+err.Error())
		return false
	}
	return true
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if !strings.HasSuffix(r.URL.Path, "/health") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

func queryInt(r *http.Request, key string, fallback, max int) int {
	var value int
	if _, err := fmt.Sscan(r.URL.Query().Get(key), &value); err != nil || value < 1 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}
