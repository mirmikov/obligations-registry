package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	desktopAppLatestVersion  = "1.4.0"
	desktopAppDownloadURL    = "https://github.com/mirmikov/obligations-registry/releases/download/registry-notifier-v1.4.0/RegistryNotifier-win-x64.zip"
	desktopAppLANDownloadURL = "/api/desktop/app/package"
	desktopAppSHA256         = "D5633F083D9AA79FAB3A982035F8267837AA0C99D2DC281DFB45C85008636244"
	desktopAppSize           = int64(45980315)
)

var (
	desktopVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	desktopSHA256Pattern  = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)
)

type desktopAppUpdate struct {
	Version        string `json:"version"`
	DownloadURL    string `json:"download_url"`
	LANDownloadURL string `json:"lan_download_url,omitempty"`
	SHA256         string `json:"sha256"`
	Size           int64  `json:"size"`
	ReleaseNotes   string `json:"release_notes"`
}

func currentDesktopAppUpdate() desktopAppUpdate {
	return desktopAppUpdate{
		Version:        desktopAppLatestVersion,
		DownloadURL:    desktopAppDownloadURL,
		LANDownloadURL: desktopAppLANDownloadURL,
		SHA256:         desktopAppSHA256,
		Size:           desktopAppSize,
		ReleaseNotes:   "Исправлены SSL-ошибки обновления на старых Windows и повторное предупреждение безопасности. Пакет проверяется и загружается через локальный сервер ФинРеестра.",
	}
}

func (a *app) desktopAppPackage(w http.ResponseWriter, r *http.Request) {
	manifest := currentDesktopAppUpdate()
	if !validDesktopAppUpdate(manifest) {
		fail(w, http.StatusServiceUnavailable, "Обновление Windows-приложения временно недоступно")
		return
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	proxyDesktopAppPackage(w, r, client, manifest.DownloadURL, manifest.Size)
}

func proxyDesktopAppPackage(w http.ResponseWriter, r *http.Request, client *http.Client, sourceURL string, expectedSize int64) {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, sourceURL, nil)
	if err != nil {
		fail(w, http.StatusBadGateway, "Не удалось подготовить пакет обновления")
		return
	}
	request.Header.Set("User-Agent", "Mirt-RegistryNotifier-Update-Proxy/1.0")
	response, err := client.Do(request)
	if err != nil {
		fail(w, http.StatusBadGateway, "Сервер обновлений временно недоступен")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || (response.ContentLength >= 0 && response.ContentLength != expectedSize) {
		fail(w, http.StatusBadGateway, "Сервер обновлений вернул некорректный пакет")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="RegistryNotifier-win-x64.zip"`)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", expectedSize))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	written, copyErr := io.Copy(w, io.LimitReader(response.Body, expectedSize+1))
	if copyErr != nil || written != expectedSize {
		log.Printf("desktop update package proxy failed after %d bytes: %v", written, copyErr)
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
	return err == nil && parsed.Scheme == "https" && parsed.Host == "github.com" && strings.HasPrefix(parsed.Path, "/mirmikov/obligations-registry/releases/download/") && (value.LANDownloadURL == "" || value.LANDownloadURL == desktopAppLANDownloadURL)
}
