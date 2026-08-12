package main

import "testing"

func TestDesktopAppUpdateManifestValidation(t *testing.T) {
	valid := desktopAppUpdate{
		Version:     "1.2.0",
		DownloadURL: "https://github.com/mirmikov/obligations-registry/releases/download/registry-notifier-v1.2.0/RegistryNotifier-win-x64.zip",
		SHA256:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Size:        50 * 1024 * 1024,
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
		"invalid checksum": func(value *desktopAppUpdate) { value.SHA256 = "unknown" },
		"empty asset":      func(value *desktopAppUpdate) { value.Size = 0 },
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
