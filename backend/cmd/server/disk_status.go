package main

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const diskStatusPath = "/host-filesystem"

type diskStatusResponse struct {
	State          string  `json:"state"`
	Path           string  `json:"path"`
	TotalBytes     int64   `json:"total_bytes,omitempty"`
	UsedBytes      int64   `json:"used_bytes,omitempty"`
	AvailableBytes int64   `json:"available_bytes,omitempty"`
	UsedPercent    float64 `json:"used_percent,omitempty"`
}

func readDiskStatus(ctx context.Context) diskStatusResponse {
	result := diskStatusResponse{State: "unavailable", Path: diskStatusPath}
	commandContext, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(commandContext, "df", "-Pk", diskStatusPath).Output()
	if err != nil {
		return result
	}
	parsed, ok := parseDiskStatus(string(raw), diskStatusPath)
	if !ok {
		return result
	}
	return parsed
}

func parseDiskStatus(output, path string) (diskStatusResponse, bool) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) < 2 {
		return diskStatusResponse{}, false
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 6 {
		return diskStatusResponse{}, false
	}
	totalKB, totalErr := strconv.ParseInt(fields[1], 10, 64)
	usedKB, usedErr := strconv.ParseInt(fields[2], 10, 64)
	availableKB, availableErr := strconv.ParseInt(fields[3], 10, 64)
	percent, percentErr := strconv.ParseFloat(strings.TrimSuffix(fields[4], "%"), 64)
	if totalErr != nil || usedErr != nil || availableErr != nil || percentErr != nil || totalKB <= 0 || usedKB < 0 || availableKB < 0 || percent < 0 || percent > 100 {
		return diskStatusResponse{}, false
	}
	return diskStatusResponse{
		State: "available", Path: path, TotalBytes: totalKB * 1024, UsedBytes: usedKB * 1024,
		AvailableBytes: availableKB * 1024, UsedPercent: percent,
	}, true
}
