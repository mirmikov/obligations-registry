package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopAppUpdateManifestValidation(t *testing.T) {
	valid := desktopAppUpdate{
		Version:        "1.2.0",
		DownloadURL:    "https://github.com/mirmikov/obligations-registry/releases/download/registry-notifier-v1.2.0/RegistryNotifier-win-x64.zip",
		LANDownloadURL: desktopAppLANDownloadURL,
		SHA256:         "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Size:           50 * 1024 * 1024,
	}
	if !validDesktopAppUpdate(valid) {
		t.Fatal("valid release manifest was rejected")
	}
	for name, mutate := range map[string]func(*desktopAppUpdate){
		"invalid version": func(value *desktopAppUpdate) { value.Version = "latest" },
		"insecure URL":    func(value *desktopAppUpdate) { value.DownloadURL = "http://github.com/release.zip" },
		"foreign host":    func(value *desktopAppUpdate) { value.DownloadURL = "https://example.org/release.zip" },
		"wrong repository": func(value *desktopAppUpdate) {
			value.DownloadURL = "https://github.com/other/repository/releases/download/v1/app.zip"
		},
		"foreign LAN route": func(value *desktopAppUpdate) { value.LANDownloadURL = "/api/admin/export" },
		"invalid checksum":  func(value *desktopAppUpdate) { value.SHA256 = "unknown" },
		"empty asset":       func(value *desktopAppUpdate) { value.Size = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			if validDesktopAppUpdate(candidate) {
				t.Fatalf("invalid manifest %q was accepted", name)
			}
		})
	}
}

func TestProxyDesktopAppPackage(t *testing.T) {
	const packageBody = "verified-package"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "Mirt-RegistryNotifier-Update-Proxy/1.0" {
			t.Fatalf("unexpected user agent: %q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Length", "16")
		_, _ = w.Write([]byte(packageBody))
	}))
	defer upstream.Close()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/desktop/app/package", nil)
	proxyDesktopAppPackage(recorder, request, upstream.Client(), upstream.URL, int64(len(packageBody)))
	result := recorder.Result()
	defer result.Body.Close()
	if result.StatusCode != http.StatusOK || recorder.Body.String() != packageBody {
		t.Fatalf("unexpected package proxy response: status=%d body=%q", result.StatusCode, recorder.Body.String())
	}
	if result.Header.Get("Content-Type") != "application/zip" || !strings.Contains(result.Header.Get("Content-Disposition"), "RegistryNotifier-win-x64.zip") || result.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing package security headers: %#v", result.Header)
	}
}

func TestProxyDesktopAppPackageRejectsWrongSize(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "3")
		_, _ = w.Write([]byte("bad"))
	}))
	defer upstream.Close()
	recorder := httptest.NewRecorder()
	proxyDesktopAppPackage(recorder, httptest.NewRequest(http.MethodGet, "/api/desktop/app/package", nil), upstream.Client(), upstream.URL, 10)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("wrong-size package was accepted: %d", recorder.Code)
	}
}

func TestCurrentDesktopAppUpdatePublishesNotifierVersion140(t *testing.T) {
	manifest := currentDesktopAppUpdate()
	if manifest.Version != "1.4.0" || manifest.Size != 45980315 || manifest.SHA256 != "D5633F083D9AA79FAB3A982035F8267837AA0C99D2DC281DFB45C85008636244" || manifest.LANDownloadURL != desktopAppLANDownloadURL {
		t.Fatalf("unexpected current desktop manifest: %#v", manifest)
	}
	if !validDesktopAppUpdate(manifest) || manifest.ReleaseNotes == "" {
		t.Fatalf("current desktop manifest is incomplete: %#v", manifest)
	}
}
