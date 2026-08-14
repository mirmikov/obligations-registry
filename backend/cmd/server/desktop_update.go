package main

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const (
	desktopAppLatestVersion = "1.3.0"
	desktopAppDownloadURL   = "https://github.com/mirmikov/obligations-registry/releases/download/registry-notifier-v1.3.0/RegistryNotifier-win-x64.zip"
	desktopAppSHA256        = "00E270B0A9F0490B58E78B577C657FB7621E6FE5E207FC39A1BF939A5B0D13FA"
	desktopAppSize          = int64(45978450)
)

var (
	desktopVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	desktopSHA256Pattern  = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)
)

type desktopAppUpdate struct {
	Version      string `json:"version"`
	DownloadURL  string `json:"download_url"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	ReleaseNotes string `json:"release_notes"`
}

func currentDesktopAppUpdate() desktopAppUpdate {
	return desktopAppUpdate{
		Version:      desktopAppLatestVersion,
		DownloadURL:  desktopAppDownloadURL,
		SHA256:       desktopAppSHA256,
		Size:         desktopAppSize,
		ReleaseNotes: "Добавлены защищённая история и центр уведомлений с поиском, последняя успешная синхронизация и щадящее переподключение при сбоях сети.",
	}
}

func (a *app) desktopAppUpdateManifest(w http.ResponseWriter, _ *http.Request) {
	manifest := currentDesktopAppUpdate()
	if !validDesktopAppUpdate(manifest) {
		fail(w, http.StatusServiceUnavailable, "Обновление Windows-приложения временно недоступно")
		return
	}
	writeJSON(w, http.StatusOK, manifest)
}

func validDesktopAppUpdate(value desktopAppUpdate) bool {
	if !desktopVersionPattern.MatchString(strings.TrimSpace(value.Version)) || !desktopSHA256Pattern.MatchString(value.SHA256) || value.Size < 1 || value.Size > 250*1024*1024 {
		return false
	}
	parsed, err := url.Parse(value.DownloadURL)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "github.com" && strings.HasPrefix(parsed.Path, "/mirmikov/obligations-registry/releases/download/")
}
