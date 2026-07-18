package main

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const presenceTTL = 18 * time.Second

type presenceInput struct {
	SessionID  string `json:"session_id"`
	Page       string `json:"page"`
	PageLabel  string `json:"page_label"`
	RecordID   int64  `json:"record_id"`
	SourceRow  int    `json:"source_row"`
	Field      string `json:"field"`
	FieldLabel string `json:"field_label"`
	Mode       string `json:"mode"`
}

type presenceEntry struct {
	SessionID  string    `json:"session_id"`
	UserID     int64     `json:"user_id"`
	Name       string    `json:"name"`
	Role       string    `json:"role"`
	Color      string    `json:"color"`
	Page       string    `json:"page"`
	PageLabel  string    `json:"page_label"`
	RecordID   int64     `json:"record_id,omitempty"`
	SourceRow  int       `json:"source_row,omitempty"`
	Field      string    `json:"field,omitempty"`
	FieldLabel string    `json:"field_label,omitempty"`
	Mode       string    `json:"mode"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type presenceHub struct {
	mu      sync.Mutex
	entries map[string]presenceEntry
}

func newPresenceHub() *presenceHub { return &presenceHub{entries: map[string]presenceEntry{}} }

func (hub *presenceHub) update(user authUser, input presenceInput, now time.Time) presenceEntry {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	entry := presenceEntry{
		SessionID: cleanPresenceText(input.SessionID, 100), UserID: user.ID, Name: user.Name, Role: user.Role,
		Color: presenceColor(user.ID), Page: cleanPresenceText(input.Page, 40), PageLabel: cleanPresenceText(input.PageLabel, 80),
		RecordID: input.RecordID, SourceRow: input.SourceRow, Field: cleanPresenceText(input.Field, 60),
		FieldLabel: cleanPresenceText(input.FieldLabel, 100), Mode: cleanPresenceText(input.Mode, 20), UpdatedAt: now,
	}
	if entry.Mode != "edit" {
		entry.Mode = "view"
	}
	hub.entries[entry.SessionID] = entry
	return entry
}

func (hub *presenceHub) list(now time.Time) []presenceEntry {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	result := make([]presenceEntry, 0, len(hub.entries))
	for key, entry := range hub.entries {
		if now.Sub(entry.UpdatedAt) > presenceTTL {
			delete(hub.entries, key)
			continue
		}
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Mode != result[j].Mode {
			return result[i].Mode == "edit"
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func (hub *presenceHub) remove(sessionID string, userID int64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if entry, ok := hub.entries[sessionID]; ok && entry.UserID == userID {
		delete(hub.entries, sessionID)
	}
}

func (a *app) updatePresence(w http.ResponseWriter, r *http.Request) {
	var input presenceInput
	if !decodeJSON(w, r, &input) {
		return
	}
	input.SessionID = strings.TrimSpace(input.SessionID)
	if len(input.SessionID) < 8 || len(input.SessionID) > 100 {
		fail(w, http.StatusBadRequest, "Некорректная сессия присутствия")
		return
	}
	writeJSON(w, http.StatusOK, a.presence.update(currentUser(r), input, time.Now()))
}

func (a *app) listPresence(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": a.presence.list(time.Now()), "ttl_seconds": int(presenceTTL.Seconds())})
}

func (a *app) removePresence(w http.ResponseWriter, r *http.Request) {
	a.presence.remove(r.PathValue("session"), currentUser(r).ID)
	w.WriteHeader(http.StatusNoContent)
}

func cleanPresenceText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > limit {
		return string([]rune(value)[:limit])
	}
	return value
}

func presenceColor(userID int64) string {
	colors := []string{"#2E7D6E", "#6D5CA8", "#C06B3E", "#3E6FA8", "#A14F67", "#6C7B35", "#9A6A28", "#3D7C8A"}
	if userID < 0 {
		userID = -userID
	}
	return colors[int(userID)%len(colors)]
}
