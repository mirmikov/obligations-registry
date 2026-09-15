package main

import "testing"

func TestParseDiskStatus(t *testing.T) {
	output := "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mapper/vm 202947748 39438260 154584076 21% /\n"
	status, ok := parseDiskStatus(output, diskStatusPath)
	if !ok {
		t.Fatal("valid df output was rejected")
	}
	if status.State != "available" || status.TotalBytes != 202947748*1024 || status.UsedBytes != 39438260*1024 || status.AvailableBytes != 154584076*1024 || status.UsedPercent != 21 {
		t.Fatalf("unexpected disk status: %+v", status)
	}
}

func TestParseDiskStatusRejectsIncompleteOutput(t *testing.T) {
	if _, ok := parseDiskStatus("Filesystem Used\n/dev/root nope", diskStatusPath); ok {
		t.Fatal("invalid df output was accepted")
	}
}
