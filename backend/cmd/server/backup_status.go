package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

const (
	backupScheduleHour = 18
	backupTimezone     = "Europe/Moscow"
)

type backupStatusFile struct {
	Success         bool   `json:"success"`
	CompletedAt     string `json:"completed_at"`
	BackupName      string `json:"backup_name"`
	Version         string `json:"version"`
	DatabaseVersion string `json:"database_version"`
	SizeBytes       int64  `json:"size_bytes"`
	Valid           bool   `json:"valid"`
	Error           string `json:"error,omitempty"`
}

type backupStatusResponse struct {
	State           string `json:"state"`
	Success         bool   `json:"success"`
	TodayCompleted  bool   `json:"today_completed"`
	Schedule        string `json:"schedule"`
	Timezone        string `json:"timezone"`
	CompletedAt     string `json:"completed_at,omitempty"`
	BackupName      string `json:"backup_name,omitempty"`
	Version         string `json:"version,omitempty"`
	DatabaseVersion string `json:"database_version,omitempty"`
	SizeBytes       int64  `json:"size_bytes,omitempty"`
	Valid           bool   `json:"valid"`
	NextRun         string `json:"next_run"`
	Error           string `json:"error,omitempty"`
}

func readBackupStatus(now time.Time) backupStatusResponse {
	path := getenv("BACKUP_STATUS_FILE", "/data/backup_status/latest-backup-status.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return buildBackupStatus(now, backupStatusFile{}, err)
	}
	if len(raw) > 64*1024 {
		return buildBackupStatus(now, backupStatusFile{}, errors.New("backup status file is too large"))
	}
	var value backupStatusFile
	if err = json.Unmarshal(raw, &value); err != nil {
		return buildBackupStatus(now, backupStatusFile{}, err)
	}
	return buildBackupStatus(now, value, nil)
}

func buildBackupStatus(now time.Time, value backupStatusFile, readErr error) backupStatusResponse {
	location, err := time.LoadLocation(backupTimezone)
	if err != nil {
		location = time.FixedZone("MSK", 3*60*60)
	}
	now = now.In(location)
	todayRun := time.Date(now.Year(), now.Month(), now.Day(), backupScheduleHour, 0, 0, 0, location)
	nextRun := todayRun
	if !now.Before(todayRun) {
		nextRun = todayRun.AddDate(0, 0, 1)
	}
	response := backupStatusResponse{
		State: "not_run", Schedule: "18:00", Timezone: backupTimezone,
		NextRun: nextRun.Format(time.RFC3339),
	}
	if readErr != nil {
		if !errors.Is(readErr, os.ErrNotExist) {
			response.State = "unavailable"
		}
		return response
	}
	response.Success = value.Success
	response.CompletedAt = strings.TrimSpace(value.CompletedAt)
	response.BackupName = strings.TrimSpace(value.BackupName)
	response.Version = strings.TrimSpace(value.Version)
	response.DatabaseVersion = strings.TrimSpace(value.DatabaseVersion)
	response.SizeBytes = value.SizeBytes
	response.Valid = value.Valid
	response.Error = strings.TrimSpace(value.Error)
	completed, parseErr := time.Parse(time.RFC3339, value.CompletedAt)
	if parseErr == nil {
		completed = completed.In(location)
		response.TodayCompleted = completed.Year() == now.Year() && completed.YearDay() == now.YearDay()
	}
	switch {
	case !value.Success || !value.Valid:
		response.State = "failed"
	case parseErr != nil:
		response.State = "unavailable"
	case !now.Before(todayRun) && !response.TodayCompleted:
		response.State = "overdue"
	default:
		response.State = "completed"
	}
	return response
}
