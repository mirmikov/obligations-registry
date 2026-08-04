package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const maxObligationScanSize = 20 << 20

type obligationScanMeta struct {
	OriginalName string `json:"name"`
	StoredName   string `json:"stored_name"`
	ContentType  string `json:"content_type"`
	Size         int64  `json:"size"`
	UpdatedAt    string `json:"updated_at"`
}

func obligationScanDirectory() string {
	return getenv("OBLIGATION_SCAN_DIR", filepath.Join(chatImageDirectory(), "obligation_scans"))
}

func obligationScanRecordDirectory(id int64) string {
	return filepath.Join(obligationScanDirectory(), strconv.FormatInt(id, 10))
}

func readObligationScan(id int64) (obligationScanMeta, bool) {
	var meta obligationScanMeta
	directory := obligationScanRecordDirectory(id)
	payload, err := os.ReadFile(filepath.Join(directory, "metadata.json"))
	if err != nil || json.Unmarshal(payload, &meta) != nil || meta.StoredName == "" || filepath.Base(meta.StoredName) != meta.StoredName {
		return obligationScanMeta{}, false
	}
	info, err := os.Stat(filepath.Join(directory, meta.StoredName))
	if err != nil || !info.Mode().IsRegular() {
		return obligationScanMeta{}, false
	}
	meta.Size = info.Size()
	return meta, true
}

func detectObligationScan(data []byte) (string, string, bool) {
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		return "application/pdf", ".pdf", true
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return "image/webp", ".webp", true
	}
	type detected struct{ contentType, extension string }
	allowed := map[string]detected{
		"application/pdf": {"application/pdf", ".pdf"},
		"image/png":       {"image/png", ".png"},
		"image/jpeg":      {"image/jpeg", ".jpg"},
		"image/webp":      {"image/webp", ".webp"},
	}
	kind, ok := allowed[http.DetectContentType(data)]
	return kind.contentType, kind.extension, ok
}

func cleanObligationScanName(name, extension string) string {
	name = strings.TrimSpace(filepath.Base(strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)))
	if name == "" || name == "." {
		return "Скан документа" + extension
	}
	runes := []rune(name)
	if len(runes) > 180 {
		name = string(runes[:180])
	}
	return name
}

func saveObligationScan(id int64, originalName string, data []byte) (obligationScanMeta, error) {
	contentType, extension, ok := detectObligationScan(data)
	if !ok {
		return obligationScanMeta{}, errors.New("unsupported scan format")
	}
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return obligationScanMeta{}, err
	}
	meta := obligationScanMeta{
		OriginalName: cleanObligationScanName(originalName, extension),
		StoredName:   hex.EncodeToString(random) + extension,
		ContentType:  contentType,
		Size:         int64(len(data)),
		UpdatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	directory := obligationScanRecordDirectory(id)
	if err := os.MkdirAll(directory, 0750); err != nil {
		return obligationScanMeta{}, err
	}
	dataPath := filepath.Join(directory, meta.StoredName)
	if err := os.WriteFile(dataPath, data, 0640); err != nil {
		return obligationScanMeta{}, err
	}
	metadata, err := json.Marshal(meta)
	if err != nil {
		_ = os.Remove(dataPath)
		return obligationScanMeta{}, err
	}
	temporaryMeta := filepath.Join(directory, "metadata.json.tmp")
	if err = os.WriteFile(temporaryMeta, metadata, 0640); err != nil {
		_ = os.Remove(dataPath)
		return obligationScanMeta{}, err
	}
	if err = os.Rename(temporaryMeta, filepath.Join(directory, "metadata.json")); err != nil {
		_ = os.Remove(dataPath)
		_ = os.Remove(temporaryMeta)
		return obligationScanMeta{}, err
	}
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		if !entry.IsDir() && entry.Name() != meta.StoredName && entry.Name() != "metadata.json" {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
	return meta, nil
}

func removeObligationScan(id int64) error {
	meta, ok := readObligationScan(id)
	if !ok {
		return os.ErrNotExist
	}
	directory := obligationScanRecordDirectory(id)
	if err := os.Remove(filepath.Join(directory, meta.StoredName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(filepath.Join(directory, "metadata.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(directory)
	return nil
}

func (a *app) uploadObligationScan(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		fail(w, http.StatusBadRequest, "Некорректный ID")
		return
	}
	var exists bool
	if err = a.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM obligations WHERE id=$1)`, id).Scan(&exists); err != nil || !exists {
		fail(w, http.StatusNotFound, "Платёж не найден")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxObligationScanSize+(256<<10))
	if err = r.ParseMultipartForm(maxObligationScanSize + (128 << 10)); err != nil {
		fail(w, http.StatusBadRequest, "Не удалось прочитать скан документа")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("scan")
	if err != nil {
		fail(w, http.StatusBadRequest, "Выберите файл скана")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxObligationScanSize+1))
	if err != nil || len(data) == 0 || len(data) > maxObligationScanSize {
		fail(w, http.StatusBadRequest, "Файл должен быть не больше 20 МБ")
		return
	}
	meta, err := saveObligationScan(id, header.Filename, data)
	if err != nil {
		if err.Error() == "unsupported scan format" {
			fail(w, http.StatusBadRequest, "Поддерживаются PDF, PNG, JPEG и WebP")
			return
		}
		fail(w, http.StatusInternalServerError, "Не удалось сохранить скан документа")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "upload", "obligation_scan", &id, map[string]any{"name": meta.OriginalName, "size": meta.Size})
	writeJSON(w, http.StatusCreated, meta)
}

func (a *app) serveObligationScan(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		fail(w, http.StatusBadRequest, "Некорректный ID")
		return
	}
	meta, ok := readObligationScan(id)
	if !ok {
		fail(w, http.StatusNotFound, "Скан документа не найден")
		return
	}
	file, err := os.Open(filepath.Join(obligationScanRecordDirectory(id), meta.StoredName))
	if err != nil {
		fail(w, http.StatusNotFound, "Скан документа не найден")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusNotFound, "Скан документа не найден")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": meta.OriginalName}))
	http.ServeContent(w, r, meta.OriginalName, info.ModTime(), file)
}

func (a *app) deleteObligationScan(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		fail(w, http.StatusBadRequest, "Некорректный ID")
		return
	}
	meta, ok := readObligationScan(id)
	if !ok {
		fail(w, http.StatusNotFound, "Скан документа не найден")
		return
	}
	if err = removeObligationScan(id); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось удалить скан документа")
		return
	}
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "delete", "obligation_scan", &id, map[string]any{"name": meta.OriginalName})
	w.WriteHeader(http.StatusNoContent)
}
