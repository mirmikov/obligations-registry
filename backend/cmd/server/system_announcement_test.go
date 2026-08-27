package main

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeSystemAnnouncement(t *testing.T) {
	value, err := normalizeSystemAnnouncement(true, "  Плановые работы до 15:00  ")
	if err != nil {
		t.Fatal(err)
	}
	if !value.Active || value.Message != "Плановые работы до 15:00" {
		t.Fatalf("normalized announcement = %#v", value)
	}
	if _, err := normalizeSystemAnnouncement(true, "   "); err == nil {
		t.Fatal("active announcement without text was accepted")
	}
	if _, err := normalizeSystemAnnouncement(true, strings.Repeat("я", 501)); err == nil {
		t.Fatal("announcement longer than 500 runes was accepted")
	}
	if value, err = normalizeSystemAnnouncement(false, ""); err != nil || value.Active {
		t.Fatalf("inactive announcement = %#v, err = %v", value, err)
	}
}

func TestSystemStatusAlwaysIncludesAnnouncement(t *testing.T) {
	announcement := systemAnnouncementState{Active: true, Message: "Обновите страницу"}
	payload := systemStatusPayload(authUser{}, maintenanceState{}, announcement, time.Now())
	got, ok := payload["announcement"].(systemAnnouncementState)
	if !ok || got != announcement {
		t.Fatalf("announcement payload = %#v", payload["announcement"])
	}
}
