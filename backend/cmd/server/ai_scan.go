package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	maxAIScanPages  = 30
	aiScanLifetime  = 24 * time.Hour
	aiScanDPI       = 140
	aiScanRescueDPI = 220

	maxAIScanOCRWorkers = 6
	aiScanRenderWorkers = 2
)

// Tesseract is CPU intensive and every document is processed in a background
// goroutine. The process-wide limit prevents several simultaneous batches from
// multiplying their worker count, while still using the larger production VM.
var (
	aiScanOCRLimiter    = newAIScanLimiter(aiScanOCRWorkerLimit(runtime.GOMAXPROCS(0), os.Getenv("AI_SCAN_OCR_WORKERS")))
	aiScanRenderLimiter = newAIScanLimiter(aiScanRenderWorkers)
)

type aiScanLimiter struct {
	slots chan struct{}
}

func newAIScanLimiter(limit int) *aiScanLimiter {
	if limit < 1 {
		limit = 1
	}
	return &aiScanLimiter{slots: make(chan struct{}, limit)}
}

func (limiter *aiScanLimiter) run(ctx context.Context, operation func() error) error {
	select {
	case limiter.slots <- struct{}{}:
		defer func() { <-limiter.slots }()
		return operation()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func runAIScanRender(ctx context.Context, operation func() error) error {
	// Rendering and OCR share the same four-slot CPU budget. The narrower render
	// limiter also prevents two large PDFs from filling memory with page images at
	// once. No operation acquires these limiters in the reverse order.
	return aiScanRenderLimiter.run(ctx, func() error {
		return aiScanOCRLimiter.run(ctx, operation)
	})
}

func aiScanOCRWorkerLimit(cpuCount int, configured string) int {
	if cpuCount < 1 {
		cpuCount = 1
	}
	maximum := min(cpuCount, maxAIScanOCRWorkers)
	if value, err := strconv.Atoi(strings.TrimSpace(configured)); err == nil && strings.TrimSpace(configured) != "" {
		return max(1, min(value, maximum))
	}
	// Keep two logical CPUs free for HTTP, PostgreSQL and the frontend proxy.
	// The default is therefore four workers on the production VM with 6 vCPU.
	return max(1, min(cpuCount-2, min(4, maximum)))
}

type aiScanBatchMeta struct {
	OriginalName string             `json:"original_name"`
	CreatedAt    time.Time          `json:"created_at"`
	PageCount    int                `json:"page_count"`
	Status       string             `json:"status"`
	Error        string             `json:"error,omitempty"`
	Items        []aiScanSuggestion `json:"items,omitempty"`
}

type aiScanSuggestion struct {
	Page              int               `json:"page"`
	Counterparty      string            `json:"counterparty"`
	CounterpartyTaxID string            `json:"counterparty_tax_id,omitempty"`
	LegalEntity       string            `json:"legal_entity"`
	DocumentNumber    string            `json:"document_number"`
	DocumentDate      string            `json:"document_date"`
	Amount            *float64          `json:"amount"`
	Duplicate         bool              `json:"duplicate"`
	DuplicateMatches  []duplicateMatch  `json:"duplicate_matches,omitempty"`
	Confidence        map[string]string `json:"confidence"`
	Warnings          []string          `json:"warnings"`
}

type aiScanCommitItem struct {
	Page              int             `json:"page"`
	Values            obligationInput `json:"values"`
	CounterpartyTaxID string          `json:"-"`
}

type aiScanCounterpartyReference struct {
	Value string
	TaxID string
}

func aiScanDirectory() string {
	return getenv("AI_SCAN_DIR", filepath.Join(chatImageDirectory(), "ai_scan_batches"))
}

func validAIScanToken(value string) bool {
	if len(value) != 48 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func aiScanBatchDirectory(token string) (string, bool) {
	if !validAIScanToken(token) {
		return "", false
	}
	return filepath.Join(aiScanDirectory(), token), true
}

func cleanupAIScanBatches() {
	entries, err := os.ReadDir(aiScanDirectory())
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-aiScanLifetime)
	for _, entry := range entries {
		if !entry.IsDir() || !validAIScanToken(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(aiScanDirectory(), entry.Name()))
		}
	}
}

func (a *app) analyzeObligationScan(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxObligationScanSize+(256<<10))
	if err := r.ParseMultipartForm(maxObligationScanSize + (128 << 10)); err != nil {
		fail(w, http.StatusBadRequest, "Не удалось прочитать документ. Максимальный размер — 20 МБ")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("scan")
	if err != nil {
		fail(w, http.StatusBadRequest, "Выберите PDF, PNG или JPEG")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxObligationScanSize+1))
	if err != nil || len(data) == 0 || len(data) > maxObligationScanSize {
		fail(w, http.StatusBadRequest, "Документ должен быть непустым и не больше 20 МБ")
		return
	}
	contentType, extension, ok := detectObligationScan(data)
	if !ok || contentType == "image/webp" {
		fail(w, http.StatusBadRequest, "Для AI-сканирования поддерживаются PDF, PNG и JPEG")
		return
	}

	cleanupAIScanBatches()
	tokenBytes := make([]byte, 24)
	if _, err = rand.Read(tokenBytes); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить анализ")
		return
	}
	token := hex.EncodeToString(tokenBytes)
	directory := filepath.Join(aiScanDirectory(), token)
	if err = os.MkdirAll(directory, 0750); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить анализ")
		return
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(directory)
		}
	}()
	inputPath := filepath.Join(directory, "source"+extension)
	if err = os.WriteFile(inputPath, data, 0640); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось сохранить документ для анализа")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 80*time.Second)
	defer cancel()
	pages, err := prepareAIScanPages(ctx, inputPath, contentType, directory)
	if err != nil {
		log.Printf("prepare AI scan: %v", err)
		fail(w, http.StatusUnprocessableEntity, "Не удалось разделить документ на страницы")
		return
	}
	if len(pages) == 0 || len(pages) > maxAIScanPages {
		fail(w, http.StatusBadRequest, fmt.Sprintf("Документ должен содержать от 1 до %d страниц", maxAIScanPages))
		return
	}
	meta := aiScanBatchMeta{OriginalName: cleanObligationScanName(header.Filename, extension), CreatedAt: time.Now().UTC(), PageCount: len(pages), Status: "processing"}
	if err = writeAIScanBatchMeta(directory, meta); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить анализ")
		return
	}
	success = true
	user := currentUser(r)
	a.audit(r.Context(), user.ID, "analyze", "obligation_ai_scan", nil, map[string]any{"name": meta.OriginalName, "pages": len(pages)})
	go a.processAIScanBatch(token, directory, pages)
	writeJSON(w, http.StatusAccepted, map[string]any{"batch": token, "pages": len(pages), "engine": "Локальное OCR", "status": "processing"})
}

func writeAIScanBatchMeta(directory string, meta aiScanBatchMeta) error {
	payload, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	temporary := filepath.Join(directory, "metadata.json.tmp")
	if err = os.WriteFile(temporary, payload, 0640); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(directory, "metadata.json"))
}

func (a *app) processAIScanBatch(token, directory string, pages []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	_, meta, ok := readAIScanBatch(token)
	if !ok {
		return
	}
	failBatch := func(message string, err error) {
		if err != nil {
			log.Printf("AI scan batch %s: %v", token, err)
		}
		meta.Status = "error"
		meta.Error = message
		_ = writeAIScanBatchMeta(directory, meta)
	}
	counterparties, legalEntities, err := a.aiScanReferences(ctx)
	if err != nil {
		failBatch("Не удалось загрузить справочники для распознавания", err)
		return
	}
	textLayer, textLayerErr := extractAIScanPDFTextLayer(ctx, directory, len(pages))
	if textLayerErr != nil {
		log.Printf("AI scan text layer %s: %v", token, textLayerErr)
	}
	ocrTexts, ocrErrors := recognizeAIScanPages(ctx, pages, directory, textLayer)
	suggestions := make([]aiScanSuggestion, len(pages))
	for index, text := range ocrTexts {
		suggestions[index] = parseAIScanTextWithReferences(text, counterparties, legalEntities)
		// Even a sparse PDF text layer can contain a precise invoice header or INN.
		// Parse it independently before deciding whether raster recovery is needed;
		// never concatenate it with OCR output.
		if embedded := valueAt(textLayer, index); strings.TrimSpace(embedded) != "" && strings.TrimSpace(embedded) != strings.TrimSpace(text) {
			suggestions[index] = mergeAIScanSuggestions(suggestions[index], parseAIScanTextWithReferences(embedded, counterparties, legalEntities))
		}
	}
	recoveryErrors := recoverAIScanPages(ctx, pages, directory, textLayer, suggestions, counterparties, legalEntities)
	for index, suggestion := range suggestions {
		ocrErr := ocrErrors[index]
		if ocrErr != nil {
			log.Printf("AI scan OCR page %d: %v", index+1, ocrErr)
		}
		if recoveryErrors[index] != nil {
			log.Printf("AI scan recovery page %d: %v", index+1, recoveryErrors[index])
			if needsAIScanRecovery(suggestion) {
				suggestion.Warnings = append(suggestion.Warnings, "Дополнительное распознавание не завершено — проверьте значения вручную")
			}
		}
		suggestion.Page = index + 1
		suggestion.DuplicateMatches = a.aiScanDuplicates(ctx, suggestion)
		suggestion.Duplicate = len(suggestion.DuplicateMatches) > 0
		if ocrErr != nil {
			suggestion.Warnings = append(suggestion.Warnings, "Страница распознана не полностью — проверьте значения вручную")
		}
		suggestions[index] = suggestion
	}
	if ctx.Err() != nil {
		failBatch("Распознавание заняло слишком много времени. Попробуйте разделить PDF", ctx.Err())
		return
	}
	meta.Status = "ready"
	meta.Items = suggestions
	meta.Error = ""
	if err = writeAIScanBatchMeta(directory, meta); err != nil {
		log.Printf("save AI scan batch %s: %v", token, err)
	}
}

func (a *app) aiScanStatus(w http.ResponseWriter, r *http.Request) {
	_, meta, ok := readAIScanBatch(r.PathValue("batch"))
	if !ok {
		fail(w, http.StatusNotFound, "Результат анализа не найден")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"batch": r.PathValue("batch"), "pages": meta.PageCount, "engine": "Локальное OCR", "status": meta.Status, "error": meta.Error, "items": meta.Items})
}

func recognizeAIScanPages(ctx context.Context, pages []string, directory string, textLayer []string) ([]string, []error) {
	texts := make([]string, len(pages))
	errorsByPage := make([]error, len(pages))
	jobs := make(chan int)
	workerCount := aiScanOCRWorkerLimit(runtime.GOMAXPROCS(0), os.Getenv("AI_SCAN_OCR_WORKERS"))
	if len(pages) < workerCount {
		workerCount = len(pages)
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for worker := 0; worker < workerCount; worker++ {
		go func() {
			defer workers.Done()
			for index := range jobs {
				if index < len(textLayer) && usableAIScanTextLayer(textLayer[index]) {
					texts[index] = textLayer[index]
					continue
				}
				texts[index], errorsByPage[index] = recognizeAIScanPage(ctx, pages[index], directory, index+1)
			}
		}()
	}
	for index := range pages {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	return texts, errorsByPage
}

func recoverAIScanPages(ctx context.Context, pages []string, directory string, textLayer []string, suggestions []aiScanSuggestion, counterparties []aiScanCounterpartyReference, legalEntities []string) []error {
	errorsByPage := make([]error, len(pages))
	jobs := make(chan int)
	workerCount := aiScanOCRWorkerLimit(runtime.GOMAXPROCS(0), os.Getenv("AI_SCAN_OCR_WORKERS"))
	if len(pages) < workerCount {
		workerCount = len(pages)
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for worker := 0; worker < workerCount; worker++ {
		go func() {
			defer workers.Done()
			for index := range jobs {
				if !needsAIScanRecovery(suggestions[index]) {
					continue
				}
				recovered, recoveryErr := recoverAIScanPage(ctx, pages[index], directory, index+1, valueAt(textLayer, index), suggestions[index], counterparties, legalEntities)
				suggestions[index] = recovered
				errorsByPage[index] = recoveryErr
			}
		}()
	}
	for index := range pages {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	return errorsByPage
}

func valueAt(values []string, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	return values[index]
}

func recoverAIScanPage(ctx context.Context, pagePath, directory string, page int, textLayer string, primary aiScanSuggestion, counterparties []aiScanCounterpartyReference, legalEntities []string) (aiScanSuggestion, error) {
	imagePath, cleanup, err := prepareAIScanRecoveryPage(ctx, pagePath, directory, page)
	if err != nil {
		return primary, err
	}
	defer cleanup()

	type result struct {
		index int
		text  string
		err   error
	}
	modes := []string{"6", "11"}
	results := make(chan result, len(modes))
	for index, mode := range modes {
		go func(index int, mode string) {
			text, ocrErr := runTesseractAtDPI(ctx, imagePath, mode, aiScanRescueDPI)
			results <- result{index: index, text: text, err: ocrErr}
		}(index, mode)
	}
	texts := make([]string, len(modes))
	errorsByMode := make([]error, len(modes))
	for range modes {
		item := <-results
		texts[item.index] = item.text
		errorsByMode[item.index] = item.err
	}

	candidates := make([]aiScanSuggestion, 0, len(texts)+1)
	if strings.TrimSpace(textLayer) != "" {
		candidates = append(candidates, parseAIScanTextWithReferences(textLayer, counterparties, legalEntities))
	}
	for _, text := range texts {
		if strings.TrimSpace(text) != "" {
			// Each OCR layout is parsed independently. Concatenating PSM outputs can
			// make section regexes cross layout boundaries and invent party fields.
			candidates = append(candidates, parseAIScanTextWithReferences(text, counterparties, legalEntities))
		}
	}
	merged := mergeAIScanSuggestions(primary, candidates...)
	for _, recoveryErr := range errorsByMode {
		if recoveryErr != nil {
			return merged, recoveryErr
		}
	}
	return merged, nil
}

func prepareAIScanRecoveryPage(ctx context.Context, pagePath, directory string, page int) (string, func(), error) {
	source := filepath.Join(directory, "source.pdf")
	if _, err := os.Stat(source); err != nil {
		if os.IsNotExist(err) {
			return pagePath, func() {}, nil
		}
		return "", func() {}, err
	}
	prefix := filepath.Join(directory, fmt.Sprintf("recovery-%03d", page))
	target := prefix + ".png"
	err := runAIScanRender(ctx, func() error {
		cmd := exec.CommandContext(ctx, "pdftoppm", "-gray", "-png", "-r", strconv.Itoa(aiScanRescueDPI), "-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-singlefile", source, prefix)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if runErr := cmd.Run(); runErr != nil {
			return fmt.Errorf("pdftoppm recovery: %w: %s", runErr, strings.TrimSpace(stderr.String()))
		}
		return nil
	})
	if err != nil {
		_ = os.Remove(target)
		return "", func() {}, err
	}
	return target, func() { _ = os.Remove(target) }, nil
}

func extractAIScanPDFTextLayer(ctx context.Context, directory string, pageCount int) ([]string, error) {
	result := make([]string, pageCount)
	source := filepath.Join(directory, "source.pdf")
	if _, err := os.Stat(source); err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		return result, err
	}
	textCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(textCtx, "pdftotext", "-layout", "-enc", "UTF-8", source, "-")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return result, fmt.Errorf("pdftotext: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	pages := strings.Split(strings.ReplaceAll(stdout.String(), "\r", ""), "\f")
	for index := 0; index < pageCount && index < len(pages); index++ {
		result[index] = strings.TrimSpace(pages[index])
	}
	return result, nil
}

func usableAIScanTextLayer(text string) bool {
	return len([]rune(strings.TrimSpace(text))) >= 80 && aiScanTextScore(text) >= 70
}

func prepareAIScanPages(ctx context.Context, inputPath, contentType, directory string) ([]string, error) {
	if contentType != "application/pdf" {
		pagePath := filepath.Join(directory, "page-001.png")
		if err := convertImageToPNG(inputPath, pagePath, 0); err != nil {
			return nil, err
		}
		return []string{pagePath}, nil
	}
	prefix := filepath.Join(directory, "rendered")
	if err := runAIScanRender(ctx, func() error {
		cmd := exec.CommandContext(ctx, "pdftoppm", "-png", "-r", strconv.Itoa(aiScanDPI), "-f", "1", "-l", strconv.Itoa(maxAIScanPages+1), inputPath, prefix)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if runErr := cmd.Run(); runErr != nil {
			return fmt.Errorf("pdftoppm: %w: %s", runErr, strings.TrimSpace(stderr.String()))
		}
		return nil
	}); err != nil {
		return nil, err
	}
	rendered, err := filepath.Glob(prefix + "-*.png")
	if err != nil {
		return nil, err
	}
	sort.Strings(rendered)
	if len(rendered) > maxAIScanPages {
		return rendered, nil
	}
	pages := make([]string, 0, len(rendered))
	for index, source := range rendered {
		target := filepath.Join(directory, fmt.Sprintf("page-%03d.png", index+1))
		if err = os.Rename(source, target); err != nil {
			return nil, err
		}
		pages = append(pages, target)
	}
	return pages, nil
}

func recognizeAIScanPage(ctx context.Context, pagePath, directory string, page int) (string, error) {
	text, err := runTesseract(ctx, pagePath)
	bestText, bestScore := text, aiScanTextScore(text)
	// Tesseract's PSM 1 already performs orientation detection. Rotation is a
	// fallback only for genuinely unreadable pages; retrying a readable but
	// sparse invoice three times makes multi-page batches unnecessarily slow.
	if err == nil && (bestScore >= 70 || len([]rune(strings.TrimSpace(text))) >= 800) {
		return bestText, nil
	}
	var lastErr = err
	for _, angle := range []int{90, 270} {
		rotated := filepath.Join(directory, fmt.Sprintf("ocr-%03d-%d.png", page, angle))
		if rotateErr := convertImageToPNG(pagePath, rotated, angle); rotateErr != nil {
			lastErr = rotateErr
			continue
		}
		candidate, candidateErr := runTesseract(ctx, rotated)
		_ = os.Remove(rotated)
		if score := aiScanTextScore(candidate); score > bestScore {
			bestText, bestScore = candidate, score
		}
		if candidateErr != nil {
			lastErr = candidateErr
		}
	}
	if strings.TrimSpace(bestText) != "" {
		return bestText, nil
	}
	return "", lastErr
}

func runTesseract(ctx context.Context, imagePath string) (string, error) {
	return runTesseractWithPSM(ctx, imagePath, "1")
}

func runTesseractWithPSM(ctx context.Context, imagePath, pageSegmentationMode string) (string, error) {
	return runTesseractAtDPI(ctx, imagePath, pageSegmentationMode, aiScanDPI)
}

func runTesseractAtDPI(ctx context.Context, imagePath, pageSegmentationMode string, dpi int) (string, error) {
	var stdout, stderr bytes.Buffer
	err := aiScanOCRLimiter.run(ctx, func() error {
		pageCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
		defer cancel()
		cmd := exec.CommandContext(pageCtx, "tesseract", imagePath, "stdout", "-l", "rus+eng", "--psm", pageSegmentationMode, "--dpi", strconv.Itoa(dpi))
		// One Tesseract process per global slot is faster and more predictable than
		// allowing every process to create its own OpenMP worker team.
		cmd.Env = append(os.Environ(), "OMP_THREAD_LIMIT=1", "OMP_NUM_THREADS=1")
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if runErr := cmd.Run(); runErr != nil {
			return fmt.Errorf("tesseract: %w: %s", runErr, strings.TrimSpace(stderr.String()))
		}
		return nil
	})
	return stdout.String(), err
}

func convertImageToPNG(source, target string, angle int) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	img, _, err := image.Decode(file)
	file.Close()
	if err != nil {
		return err
	}
	if angle == 90 || angle == 270 {
		bounds := img.Bounds()
		rotated := image.NewRGBA(image.Rect(0, 0, bounds.Dy(), bounds.Dx()))
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				if angle == 90 {
					rotated.Set(bounds.Max.Y-1-y, x-bounds.Min.X, img.At(x, y))
				} else {
					rotated.Set(y-bounds.Min.Y, bounds.Max.X-1-x, img.At(x, y))
				}
			}
		}
		img = rotated
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	err = png.Encode(out, img)
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func aiScanTextScore(text string) int {
	folded := foldAIScanText(text)
	score := len([]rune(folded)) / 20
	for _, marker := range []string{"счет", "оплату", "поставщик", "получатель", "покупатель", "плательщик", "инн", "итого"} {
		if strings.Contains(folded, marker) {
			score += 25
		}
	}
	return score
}

var (
	aiDocumentPattern         = regexp.MustCompile(`(?i)(сч[её]т\s*[-–—]?\s*оферта|сч[её]т\s*[-–—]\s*фактура|сч[её]т\s*[-–—]?\s*договор(?:\s+поставки\s+[A-Za-zА-Яа-яЁё]+)?|универсальный\s+передаточный\s+документ|упд|сч[её]т(?:\s+на\s+опл\s*ату)?|товарная\s+накладная|накладная|акт(?:\s+(?:выполненных\s+работ|оказанных\s+услуг|при[её]ма\s*[-–—]?\s*передачи))?)\s*(?:№|N(?:o|е|e|2|°|º)?|No)?\s*([0-9A-Za-zА-Яа-яЁё#./_-]+)\s+от\s+([0-9]{1,2}(?:[.\-/][0-9]{1,2}[.\-/][0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4}))`)
	aiLooseDocumentPattern    = regexp.MustCompile(`(?is)(сч[её]т\s*[-–—]?\s*оферта|сч[её]т\s*[-–—]\s*фактура|сч[её]т\s*[-–—]?\s*договор(?:\s+поставки\s+[A-Za-zА-Яа-яЁё]+)?|универсальный\s+передаточный\s+документ|упд|сч[её]т(?:\s+на\s+опл\s*ату)?|товарная\s+накладная|накладная|акт(?:\s+(?:выполненных\s+работ|оказанных\s+услуг|при[её]ма\s*[-–—]?\s*передачи))?)\s*(?:№|N(?:o|е|e|2|°|º)?|No)?\s*([0-9A-Za-zА-Яа-яЁё]+(?:\s*[#./_-]\s*[0-9A-Za-zА-Яа-яЁё]+)*)\s+от\s+([0-9]{1,2}(?:\s*[.\-/]\s*[0-9]{1,2}\s*[.\-/]\s*[0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4}))`)
	aiAmountPattern           = regexp.MustCompile(`[0-9]{1,3}(?:[ \x{00A0}][0-9]{3})*(?:[,.][0-9]{2})|[0-9]+(?:[,.][0-9]{2})|[0-9]+`)
	aiSupplierPattern         = regexp.MustCompile(`(?is)(?:поставщик|исполнитель|продавец)(?:\s*\([^)]*\))?\s*[:;]?\s*(.{3,1000}?)(?:покупатель|заказчик|плательщик|основание|товары|услуги)`)
	aiSupplierLinePattern     = regexp.MustCompile(`(?i)(?:поставщик|исполнитель|продавец)(?:\s*\([^)]*\))?\s*[:;—–-]?\s*(.*)$`)
	aiRecipientLinePattern    = regexp.MustCompile(`(?i)^\s*[\[|]?\s*получатель(?:\s+средств)?(?:\s*[:;!|]\s*|\s+|$)(.*)$`)
	aiRecipientStopPattern    = regexp.MustCompile(`(?i)^\s*(?:бик|банк\s+получателя|сч\.?\s*№|сч[её]т|код|рез\.?\s+поле|назначение\s+платежа|плательщик|покупатель|заказчик)(?:\s|:|$)`)
	aiBuyerPattern            = regexp.MustCompile(`(?is)(?:покупатель|заказчик|плательщик)(?:\s*\([^)]*\))?\s*[:;]?\s*(.{3,1000}?)(?:основание|товары|услуги|поставщик|итого|всего|наименование)`)
	aiExplicitPartyPattern    = regexp.MustCompile(`(?i)(?:[ОO0]{3}|ПАО|ОАО|ЗАО|АО|ИП)\s*(?:["«][^"»\n]{1,100}["»]|[A-Za-zА-Яа-яЁё][^,;|\n]{1,100})`)
	aiInterleavedPartyPattern = regexp.MustCompile(`(?is)^\s*(акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью)\s+(?:менеджер|телефон|почта).{0,160}?["«]([^"»\n]{2,100})["»]`)
	aiTaxIDPattern            = regexp.MustCompile(`(?i)инн(?:\s*/\s*кпп)?\s*[:;]?\s*([0-9OО][0-9OО\s-]{8,18}[0-9OО])`)
)

var (
	aiStandaloneInvoicePattern    = regexp.MustCompile(`(?im)^\s*(сч[её]т(?:\s+на\s+опл\s*ату)?)\s*(?:№|N(?:o|е|e|2|°|º)?|No)?\s*([0-9A-Za-zА-Яа-яЁё]+(?:\s*[#./_-]\s*[0-9A-Za-zА-Яа-яЁё]+)*)\s*$`)
	aiLabelledDocumentDatePattern = regexp.MustCompile(`(?im)^\s*дата(?:\s+документа)?\s*[:;]?\s*([0-9]{1,2}(?:\s*[.\-/]\s*[0-9]{1,2}\s*[.\-/]\s*[0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4}))\s*(?:г\.?|года)?\s*$`)
)

var aiMonths = map[string]int{"января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6, "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12}

func parseAIScanText(text string, counterparties, legalEntities []string) aiScanSuggestion {
	references := make([]aiScanCounterpartyReference, 0, len(counterparties))
	for _, value := range counterparties {
		references = append(references, aiScanCounterpartyReference{Value: value})
	}
	return parseAIScanTextWithReferences(text, references, legalEntities)
}

func aiScanConfidenceRank(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func needsAIScanRecovery(value aiScanSuggestion) bool {
	if strings.TrimSpace(value.Counterparty) == "" || strings.TrimSpace(value.LegalEntity) == "" || strings.TrimSpace(value.DocumentNumber) == "" || strings.TrimSpace(value.DocumentDate) == "" || value.Amount == nil {
		return true
	}
	for _, field := range []string{"counterparty", "legal_entity", "document_number", "document_date", "amount"} {
		if aiScanConfidenceRank(value.Confidence[field]) < aiScanConfidenceRank("medium") {
			return true
		}
	}
	return false
}

func shouldReplaceAIScanField(current, currentConfidence, candidate, candidateConfidence string) bool {
	if strings.TrimSpace(candidate) == "" {
		return false
	}
	if strings.TrimSpace(current) == "" {
		return true
	}
	if aiScanConfidenceRank(currentConfidence) >= aiScanConfidenceRank("high") {
		return false
	}
	return aiScanConfidenceRank(candidateConfidence) > aiScanConfidenceRank(currentConfidence)
}

func looksLikeAIScanBankParty(value string) bool {
	for _, token := range strings.Fields(foldAIScanText(value)) {
		if token == "банк" || strings.HasSuffix(token, "банк") {
			return true
		}
	}
	return false
}

func shouldReplaceAIScanCounterparty(primary, candidate aiScanSuggestion) bool {
	if strings.TrimSpace(candidate.Counterparty) == "" {
		return false
	}
	if looksLikeAIScanBankParty(candidate.Counterparty) {
		return false
	}
	if strings.TrimSpace(primary.Counterparty) == "" {
		return true
	}
	if aiScanConfidenceRank(primary.Confidence["counterparty"]) >= aiScanConfidenceRank("high") {
		return false
	}
	// Parser confidence "high" is assigned only after the supplier is matched to
	// a canonical directory entry (by INN, exact normalized name or an
	// unambiguous near-exact match). It can therefore repair a low raw OCR value
	// even when the recovery pass did not repeat the INN. Banks remain forbidden.
	return aiScanConfidenceRank(candidate.Confidence["counterparty"]) >= aiScanConfidenceRank("high")
}

func sameAIScanDocumentNumber(left, right string) bool {
	return foldAIScanText(left) != "" && foldAIScanText(left) == foldAIScanText(right)
}

func mergeAIScanDocumentPair(primary *aiScanSuggestion, candidate aiScanSuggestion) {
	if strings.TrimSpace(candidate.DocumentNumber) == "" || strings.TrimSpace(candidate.DocumentDate) == "" {
		return
	}
	numberHigh := aiScanConfidenceRank(primary.Confidence["document_number"]) >= aiScanConfidenceRank("high")
	dateHigh := aiScanConfidenceRank(primary.Confidence["document_date"]) >= aiScanConfidenceRank("high")
	if numberHigh && strings.TrimSpace(primary.DocumentNumber) != "" && !sameAIScanDocumentNumber(primary.DocumentNumber, candidate.DocumentNumber) {
		return
	}
	if dateHigh && strings.TrimSpace(primary.DocumentDate) != "" && primary.DocumentDate != candidate.DocumentDate {
		return
	}

	candidateNumberRank := aiScanConfidenceRank(candidate.Confidence["document_number"])
	candidateDateRank := aiScanConfidenceRank(candidate.Confidence["document_date"])
	currentNumberRank := aiScanConfidenceRank(primary.Confidence["document_number"])
	currentDateRank := aiScanConfidenceRank(primary.Confidence["document_date"])
	mediumRank := aiScanConfidenceRank("medium")
	if candidateNumberRank < mediumRank || candidateDateRank < mediumRank {
		return
	}

	numberMissing := strings.TrimSpace(primary.DocumentNumber) == ""
	dateMissing := strings.TrimSpace(primary.DocumentDate) == ""
	numberMatches := !numberMissing && sameAIScanDocumentNumber(primary.DocumentNumber, candidate.DocumentNumber)
	dateMatches := !dateMissing && primary.DocumentDate == candidate.DocumentDate

	switch {
	case numberMissing && dateMissing:
		primary.DocumentNumber = candidate.DocumentNumber
		primary.DocumentDate = candidate.DocumentDate
		primary.Confidence["document_number"] = candidate.Confidence["document_number"]
		primary.Confidence["document_date"] = candidate.Confidence["document_date"]
	case dateMissing && numberMatches:
		primary.DocumentDate = candidate.DocumentDate
		primary.Confidence["document_date"] = candidate.Confidence["document_date"]
		if candidateNumberRank > currentNumberRank {
			primary.Confidence["document_number"] = candidate.Confidence["document_number"]
		}
	case numberMissing && dateMatches:
		primary.DocumentNumber = candidate.DocumentNumber
		primary.Confidence["document_number"] = candidate.Confidence["document_number"]
		if candidateDateRank > currentDateRank {
			primary.Confidence["document_date"] = candidate.Confidence["document_date"]
		}
	case numberMatches && dateMatches:
		if candidateNumberRank > currentNumberRank {
			primary.Confidence["document_number"] = candidate.Confidence["document_number"]
		}
		if candidateDateRank > currentDateRank {
			primary.Confidence["document_date"] = candidate.Confidence["document_date"]
		}
	case numberMatches && !dateHigh && candidateDateRank > currentDateRank:
		primary.DocumentDate = candidate.DocumentDate
		primary.Confidence["document_date"] = candidate.Confidence["document_date"]
	case dateMatches && !numberHigh && candidateNumberRank > currentNumberRank:
		primary.DocumentNumber = candidate.DocumentNumber
		primary.Confidence["document_number"] = candidate.Confidence["document_number"]
	case !numberHigh && !dateHigh && candidateNumberRank > currentNumberRank && candidateDateRank > currentDateRank:
		// Both weak primary values may be replaced, but only as one stronger pair
		// produced by the same OCR pass.
		primary.DocumentNumber = candidate.DocumentNumber
		primary.DocumentDate = candidate.DocumentDate
		primary.Confidence["document_number"] = candidate.Confidence["document_number"]
		primary.Confidence["document_date"] = candidate.Confidence["document_date"]
	}
}

func mergeAIScanSuggestions(primary aiScanSuggestion, candidates ...aiScanSuggestion) aiScanSuggestion {
	if primary.Confidence == nil {
		primary.Confidence = map[string]string{}
	}
	for _, candidate := range candidates {
		if shouldReplaceAIScanCounterparty(primary, candidate) {
			primary.Counterparty = candidate.Counterparty
			primary.CounterpartyTaxID = candidate.CounterpartyTaxID
			primary.Confidence["counterparty"] = candidate.Confidence["counterparty"]
		} else if primary.CounterpartyTaxID == "" && candidate.CounterpartyTaxID != "" && normalizedPartyName(primary.Counterparty) == normalizedPartyName(candidate.Counterparty) {
			// The name stays untouched; an independently observed INN can safely
			// enrich the same normalized supplier and prevent duplicate references.
			primary.CounterpartyTaxID = candidate.CounterpartyTaxID
		}
		if shouldReplaceAIScanField(primary.LegalEntity, primary.Confidence["legal_entity"], candidate.LegalEntity, candidate.Confidence["legal_entity"]) {
			primary.LegalEntity = candidate.LegalEntity
			primary.Confidence["legal_entity"] = candidate.Confidence["legal_entity"]
		}
		mergeAIScanDocumentPair(&primary, candidate)
		if candidate.Amount != nil && (primary.Amount == nil || (aiScanConfidenceRank(primary.Confidence["amount"]) < aiScanConfidenceRank("high") && aiScanConfidenceRank(candidate.Confidence["amount"]) > aiScanConfidenceRank(primary.Confidence["amount"]))) {
			primary.Amount = candidate.Amount
			primary.Confidence["amount"] = candidate.Confidence["amount"]
		}
	}
	refreshAIScanWarnings(&primary)
	return primary
}

func refreshAIScanWarnings(result *aiScanSuggestion) {
	result.Warnings = result.Warnings[:0]
	missing := []struct {
		field string
		label string
	}{
		{"counterparty", "контрагент"},
		{"legal_entity", "юридическое лицо"},
		{"document_number", "номер документа"},
		{"document_date", "дата документа"},
		{"amount", "сумма"},
	}
	for _, item := range missing {
		absent := (item.field == "amount" && result.Amount == nil) || (item.field == "counterparty" && result.Counterparty == "") || (item.field == "legal_entity" && result.LegalEntity == "") || (item.field == "document_number" && result.DocumentNumber == "") || (item.field == "document_date" && result.DocumentDate == "")
		if absent {
			result.Warnings = append(result.Warnings, "Не распознано поле: "+item.label)
		}
	}
}

func setAIScanDocumentFields(result *aiScanSuggestion, text, kind, number, date string) {
	documentKind := strings.Join(strings.Fields(kind), " ")
	documentKind = regexp.MustCompile(`(?i)опл\s+ату`).ReplaceAllString(documentKind, "оплату")
	if strings.Contains(foldAIScanText(text), "универсальный передаточный документ") {
		documentKind = "УПД"
	} else if strings.Contains(foldAIScanText(documentKind), "счет договор") {
		documentKind = "Счет-договор"
	} else if strings.Contains(foldAIScanText(documentKind), "оферта") {
		documentKind = "Счет-оферта"
	} else if strings.Contains(foldAIScanText(documentKind), "фактура") {
		documentKind = "Счет-фактура"
	} else if foldAIScanText(documentKind) == "счет" {
		documentKind = "Счет"
	}
	result.DocumentNumber = documentKind + " № " + normalizeAIScanDocumentNumber(number)
	result.Confidence["document_number"] = "high"
	result.DocumentDate = parseAIScanDate(date)
	if result.DocumentDate != "" {
		result.Confidence["document_date"] = "high"
	}
}

func parseAIScanTextWithReferences(text string, counterparties []aiScanCounterpartyReference, legalEntities []string) aiScanSuggestion {
	result := aiScanSuggestion{Confidence: map[string]string{}, Warnings: []string{}}
	match := aiDocumentPattern.FindStringSubmatch(text)
	if len(match) != 4 {
		// OCR may insert spaces around a hyphen in an alphanumeric invoice
		// number. Keep the strict, long-standing expression first and use this
		// relaxed form only when the original match failed.
		match = aiLooseDocumentPattern.FindStringSubmatch(text)
	}
	if len(match) == 4 {
		setAIScanDocumentFields(&result, text, match[1], match[2], match[3])
	} else {
		// Some providers put the invoice number in its own centered header and
		// print the document date on a separate labelled line. OCR also commonly
		// turns the № sign into "Ne". Join only those two explicit invoice fields;
		// do not reuse unrelated dates elsewhere in the document.
		standalone := aiStandaloneInvoicePattern.FindStringSubmatch(text)
		labelledDate := aiLabelledDocumentDatePattern.FindStringSubmatch(text)
		if len(standalone) == 3 {
			date := ""
			if len(labelledDate) == 2 {
				date = labelledDate[1]
			}
			setAIScanDocumentFields(&result, text, standalone[1], standalone[2], date)
		}
	}
	result.Amount = parseAIScanAmount(text)
	if result.Amount != nil {
		result.Confidence["amount"] = "high"
	}
	supplierText := regexpCapture(aiSupplierPattern, text)
	buyerText := regexpCapture(aiBuyerPattern, text)
	supplierName, supplierTaxID := extractAIScanLabelledSupplier(text)
	if interleaved := extractAIScanInterleavedParty(supplierText); interleaved != "" {
		supplierName = interleaved
		supplierTaxID = extractAIScanTaxID(supplierText)
	}
	// Table OCR often emits the supplier name before the "Поставщик" cell and
	// leaves only its address after the label. In that layout the payment-table
	// recipient is the reliable supplier; never absorb a following buyer row
	// into the supplier value.
	if supplierName == "" {
		supplierName = extractAIScanRecipient(text)
	}
	if supplierName == "" {
		supplierName = extractAIScanParty(supplierText)
	}
	if supplierTaxID == "" {
		supplierTaxID = extractAIScanSupplierTaxID(text, supplierName)
	}
	result.CounterpartyTaxID = supplierTaxID
	buyerName := extractAIScanParty(buyerText)
	// A bank name and its settlement account often appear before the invoice
	// parties. Match the counterparty strictly inside the supplier section so a
	// bank from the payment details can never replace the actual supplier.
	result.Counterparty, result.Confidence["counterparty"] = bestAIScanCounterpartyReference(supplierName, result.CounterpartyTaxID, counterparties)
	if result.Counterparty == "" {
		result.Counterparty = supplierName
		if result.Counterparty != "" {
			result.Confidence["counterparty"] = "low"
		}
	} else if result.CounterpartyTaxID == "" && result.Confidence["counterparty"] == "high" {
		// Exact canonical-name matches are sufficient to reuse the directory row.
		// Return its known INN as well so duplicate prevention stays deterministic
		// when this OCR pass did not repeat the digits.
		result.CounterpartyTaxID = aiScanReferenceTaxID(result.Counterparty, counterparties)
	}
	result.LegalEntity, result.Confidence["legal_entity"] = bestAIScanReference(buyerName, legalEntities)
	if result.LegalEntity == "" {
		// In table-based UPDs, pdftotext may place the beginning of the buyer name
		// before the "Покупатель" label and its ending after the label. Match the
		// known legal entity against the whole document when the buyer block alone
		// is insufficient; counterparties are kept in a separate reference kind.
		result.LegalEntity, result.Confidence["legal_entity"] = bestAIScanReference(text, legalEntities)
	}
	if result.LegalEntity == "" {
		result.LegalEntity = buyerName
		if result.LegalEntity != "" {
			result.Confidence["legal_entity"] = "low"
		}
	}
	refreshAIScanWarnings(&result)
	return result
}

func regexpCapture(pattern *regexp.Regexp, text string) string {
	match := pattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func normalizeAIScanDocumentNumber(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	value = regexp.MustCompile(`\s*([#./_-])\s*`).ReplaceAllString(value, "$1")
	// Mango invoice prefixes are Cyrillic, while OCR often returns the three
	// visually identical Latin letters. Canonicalize this exact prefix so
	// duplicate checks treat the scanned number and the printed number equally.
	value = regexp.MustCompile(`(?i)^[MМ][KК][OО](#.*)$`).ReplaceAllString(value, "МКО$1")
	// In Russian invoice prefixes Tesseract often substitutes the visually
	// identical Latin B/X for Cyrillic В/Х. Limit normalization to the common
	// two-letter prefix followed by two digits and a separator.
	return regexp.MustCompile(`(?i)^[BВ][XХ]([0-9]{2}[-/].*)$`).ReplaceAllString(value, "ВХ$1")
}

func extractAIScanInterleavedParty(value string) string {
	match := aiInterleavedPartyPattern.FindStringSubmatch(value)
	if len(match) != 3 {
		return ""
	}
	legalForm := "ООО"
	if strings.HasPrefix(foldAIScanText(match[1]), "акционерное общество") {
		legalForm = "АО"
	}
	return legalForm + ` "` + strings.TrimSpace(match[2]) + `"`
}

func extractAIScanLabelledSupplier(text string) (string, string) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		match := aiSupplierLinePattern.FindStringSubmatch(line)
		if len(match) != 2 {
			continue
		}
		value := strings.TrimSpace(match[1])
		party := extractAIScanExplicitParty(value)
		if party == "" {
			candidate := extractAIScanParty(value)
			if looksLikeAIScanParty(candidate) {
				party = candidate
			}
		}
		if party != "" {
			return party, extractAIScanTaxID(value)
		}
	}
	return "", ""
}

func normalizeAIScanTaxID(value string) string {
	var result strings.Builder
	for _, char := range value {
		switch char {
		case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
			result.WriteRune(char)
		case 'O', 'o', 'О', 'о':
			result.WriteByte('0')
		}
	}
	if result.Len() != 10 && result.Len() != 12 {
		return ""
	}
	return result.String()
}

func extractAIScanTaxID(value string) string {
	match := aiTaxIDPattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return ""
	}
	return normalizeAIScanTaxID(match[1])
}

func extractAIScanSupplierTaxID(text, supplierName string) string {
	partyKey := normalizedPartyName(supplierName)
	if partyKey == "" {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for index, line := range lines {
		party := extractAIScanExplicitParty(line)
		if normalizedPartyName(party) != partyKey {
			continue
		}
		if taxID := extractAIScanTaxID(line); taxID != "" {
			return taxID
		}
		for offset := 1; offset <= 2; offset++ {
			for _, nearby := range []int{index - offset, index + offset} {
				if nearby >= 0 && nearby < len(lines) {
					if taxID := extractAIScanTaxID(lines[nearby]); taxID != "" {
						return taxID
					}
				}
			}
		}
	}
	return ""
}

func extractAIScanRecipient(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for index, line := range lines {
		match := aiRecipientLinePattern.FindStringSubmatch(line)
		if len(match) != 2 {
			continue
		}
		if candidate := strings.TrimSpace(match[1]); candidate != "" && !aiRecipientStopPattern.MatchString(candidate) {
			if value := extractAIScanExplicitParty(candidate); value != "" {
				return value
			}
			if value := extractAIScanParty(candidate); looksLikeAIScanParty(value) {
				return value
			}
		}
		for next := index + 1; next < len(lines) && next <= index+3; next++ {
			candidate := strings.TrimSpace(lines[next])
			if candidate == "" {
				continue
			}
			if aiRecipientStopPattern.MatchString(candidate) {
				break
			}
			if value := extractAIScanExplicitParty(candidate); value != "" {
				return value
			}
			if value := extractAIScanParty(candidate); looksLikeAIScanParty(value) {
				return value
			}
		}
	}
	// In payment-order tables Tesseract frequently emits the recipient value
	// before the cell label. Search a small window backwards and accept only an
	// explicit legal form, preventing a nearby bank/account caption from being
	// treated as the supplier.
	for index, line := range lines {
		if !strings.HasPrefix(foldAIScanText(strings.TrimLeft(line, " [|")), "получатель") {
			continue
		}
		for previous := index - 1; previous >= 0 && previous >= index-6; previous-- {
			if candidate := extractAIScanExplicitParty(lines[previous]); candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func extractAIScanExplicitParty(value string) string {
	match := aiExplicitPartyPattern.FindString(value)
	if match == "" {
		return ""
	}
	match = strings.TrimSpace(match)
	if prefix := []rune(match); len(prefix) >= 3 {
		first := strings.ToUpper(string(prefix[:3]))
		if regexp.MustCompile(`^[ОO0]{3}$`).MatchString(first) {
			match = "ООО" + string(prefix[3:])
		}
	}
	return extractAIScanParty(match)
}

func looksLikeAIScanParty(value string) bool {
	folded := foldAIScanText(value)
	if strings.HasPrefix(folded, "общество с ограниченной ответственностью") || strings.HasPrefix(folded, "индивидуальный предприниматель") {
		return true
	}
	return regexp.MustCompile(`(?i)(?:^|[^A-Za-zА-Яа-яЁё])(?:[ОO0]{3}|ПАО|ОАО|ЗАО|АО|ИП)(?:$|[^A-Za-zА-Яа-яЁё])`).MatchString(value)
}

func parseAIScanDate(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(value, "\u00a0", " "), "ё", "е"))
	value = strings.TrimSpace(regexp.MustCompile(`(?i)\s*г\.?\s*$`).ReplaceAllString(value, ""))
	if match := regexp.MustCompile(`^(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{2,4})$`).FindStringSubmatch(value); len(match) == 4 {
		day, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		year, _ := strconv.Atoi(match[3])
		if year < 100 {
			year += 2000
		}
		if validAIScanDate(year, month, day) {
			return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
		}
	}
	parts := strings.Fields(value)
	if len(parts) == 3 {
		day, _ := strconv.Atoi(parts[0])
		year, _ := strconv.Atoi(parts[2])
		month := aiMonths[parts[1]]
		if month == 0 {
			month, _ = strconv.Atoi(parts[1])
		}
		if validAIScanDate(year, month, day) {
			return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
		}
	}
	return ""
}

func validAIScanDate(year, month, day int) bool {
	if year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 {
		return false
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return date.Year() == year && int(date.Month()) == month && date.Day() == day
}

func parseAIScanAmount(text string) *float64 {
	priorities := []string{"всего к оплате", "итого к оплате", "к оплате", "всего", "итого"}
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for _, marker := range priorities {
		for _, line := range lines {
			if !strings.Contains(foldAIScanText(line), marker) {
				continue
			}
			matches := aiAmountPattern.FindAllString(line, -1)
			for index := len(matches) - 1; index >= 0; index-- {
				clean := strings.NewReplacer(" ", "", "\u00a0", "", ",", ".").Replace(matches[index])
				if amount, err := strconv.ParseFloat(clean, 64); err == nil && amount > 0 {
					return &amount
				}
			}
		}
	}
	return nil
}

func foldAIScanText(value string) string {
	value = strings.ToLower(strings.ReplaceAll(value, "ё", "е"))
	var result strings.Builder
	space := true
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			result.WriteRune(char)
			space = false
		} else if !space {
			result.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(result.String())
}

func aiScanBalancedReferenceName(value string) bool {
	return strings.Count(value, `"`)%2 == 0 && strings.Count(value, "«") == strings.Count(value, "»")
}

func aiScanReferenceNameQuality(value, detected string) int {
	score := 0
	if aiScanBalancedReferenceName(value) && strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(detected)) {
		score += 100
	}
	if aiScanBalancedReferenceName(value) {
		score += 10
	}
	return score
}

func aiScanNormalizedNameSimilarity(left, right string) float64 {
	a, b := []rune(normalizedPartyName(left)), []rune(normalizedPartyName(right))
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	previous := make([]int, len(b)+1)
	for index := range previous {
		previous[index] = index
	}
	for leftIndex, leftRune := range a {
		current := make([]int, len(b)+1)
		current[0] = leftIndex + 1
		for rightIndex, rightRune := range b {
			cost := 0
			if leftRune != rightRune {
				cost = 1
			}
			deletion := previous[rightIndex+1] + 1
			insertion := current[rightIndex] + 1
			substitution := previous[rightIndex] + cost
			current[rightIndex+1] = min(deletion, insertion, substitution)
		}
		previous = current
	}
	maximum := max(len(a), len(b))
	return 1 - float64(previous[len(b)])/float64(maximum)
}

func bestAIScanCounterpartyReference(text, taxID string, references []aiScanCounterpartyReference) (string, string) {
	taxID = normalizeAIScanTaxID(taxID)
	if taxID != "" {
		for _, reference := range references {
			if normalizeAIScanTaxID(reference.TaxID) == taxID {
				return reference.Value, "high"
			}
		}
	}
	key := normalizedPartyName(text)
	best, bestQuality := "", -1
	for _, reference := range references {
		if key == "" || normalizedPartyName(reference.Value) != key {
			continue
		}
		if taxID != "" && reference.TaxID != "" && normalizeAIScanTaxID(reference.TaxID) != taxID {
			continue
		}
		quality := aiScanReferenceNameQuality(reference.Value, text)
		if quality > bestQuality {
			best, bestQuality = reference.Value, quality
		}
	}
	if best != "" {
		return best, "high"
	}
	if taxID != "" {
		bestIndex, bestScore, secondScore := -1, 0.0, 0.0
		for index, reference := range references {
			if reference.TaxID != "" && normalizeAIScanTaxID(reference.TaxID) != taxID {
				continue
			}
			score := aiScanNormalizedNameSimilarity(text, reference.Value)
			if score > bestScore {
				bestIndex, secondScore, bestScore = index, bestScore, score
			} else if score > secondScore {
				secondScore = score
			}
		}
		// A one-character OCR substitution in a long legal name is safe to
		// reuse only when the match is both very strong and unambiguous.
		if bestIndex >= 0 && bestScore >= 0.88 && bestScore-secondScore >= 0.03 {
			return references[bestIndex].Value, "high"
		}
		// Otherwise keep the detected supplier so the commit path creates one
		// new reference with this INN instead of selecting a doubtful company.
		return "", ""
	}
	values := make([]string, 0, len(references))
	for _, reference := range references {
		values = append(values, reference.Value)
	}
	return bestAIScanReference(text, values)
}

func aiScanReferenceTaxID(value string, references []aiScanCounterpartyReference) string {
	key := normalizedPartyName(value)
	if key == "" {
		return ""
	}
	for _, reference := range references {
		if normalizedPartyName(reference.Value) == key {
			return normalizeAIScanTaxID(reference.TaxID)
		}
	}
	return ""
}

func bestAIScanReference(text string, values []string) (string, string) {
	folded := foldAIScanText(text)
	if folded == "" {
		return "", ""
	}
	best, bestScore := "", 0.0
	textTokens := aiTokenSet(folded)
	for _, value := range values {
		candidate := foldAIScanText(value)
		if candidate == "" {
			continue
		}
		score := aiTokenSimilarity(textTokens, aiTokenSet(candidate))
		if strings.Contains(folded, candidate) {
			score = 1
		}
		if score > bestScore {
			best, bestScore = value, score
		}
	}
	if bestScore >= 0.95 {
		return best, "high"
	}
	if bestScore >= 0.5 {
		return best, "medium"
	}
	return "", ""
}

func aiTokenSet(value string) map[string]struct{} {
	ignored := map[string]bool{"ооо": true, "ао": true, "ип": true, "общество": true, "ограниченной": true, "ответственностью": true, "индивидуальный": true, "предприниматель": true, "инн": true, "кпп": true}
	result := map[string]struct{}{}
	for _, token := range strings.Fields(value) {
		if len([]rune(token)) >= 2 && !ignored[token] {
			result[token] = struct{}{}
		}
	}
	return result
}

func aiTokenSimilarity(text, candidate map[string]struct{}) float64 {
	if len(candidate) == 0 {
		return 0
	}
	matched := 0
	for token := range candidate {
		if _, ok := text[token]; ok {
			matched++
		}
	}
	return float64(matched) / float64(len(candidate))
}

func extractAIScanParty(value string) string {
	value = strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(value, " "))
	if value == "" {
		return ""
	}
	if index := regexp.MustCompile(`(?i)(?:[,;]|\s)\s*(?:ИНН(?:\s*/\s*КПП)?|КПП|адрес|р\s*/?\s*с|расч[её]тн(?:ый|ого)\s+сч[её]т)`).FindStringIndex(value); index != nil {
		value = value[:index[0]]
	}
	value = strings.Trim(value, " ,;:-")
	if len([]rune(value)) > 140 {
		return ""
	}
	return value
}

func (a *app) aiScanReferences(ctx context.Context) ([]aiScanCounterpartyReference, []string, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT kind,value,COALESCE(tax_id,'') FROM reference_values WHERE active AND kind IN ('counterparties','legal_entities') ORDER BY kind,sort_order,value`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var counterparties []aiScanCounterpartyReference
	var legalEntities []string
	for rows.Next() {
		var kind, value, taxID string
		if err = rows.Scan(&kind, &value, &taxID); err != nil {
			return nil, nil, err
		}
		if kind == "counterparties" {
			counterparties = append(counterparties, aiScanCounterpartyReference{Value: value, TaxID: taxID})
		} else {
			legalEntities = append(legalEntities, value)
		}
	}
	return counterparties, legalEntities, rows.Err()
}

func (a *app) aiScanDuplicates(ctx context.Context, item aiScanSuggestion) []duplicateMatch {
	result, err := findDuplicateObligations(ctx, a.db, obligationInput{Counterparty: item.Counterparty, LegalEntity: item.LegalEntity, DocumentNumber: item.DocumentNumber, DocumentDate: item.DocumentDate, Amount: item.Amount}, 0, "")
	if err != nil {
		log.Printf("AI scan duplicate check: %v", err)
		return nil
	}
	return result.Matches
}

type aiScanReferenceAudit struct {
	ID           int64
	Value        string
	Created      bool
	Reactivated  bool
	TaxIDUpdated bool
}

type aiScanStoredCounterparty struct {
	id     int64
	value  string
	taxID  string
	active bool
}

type aiScanReferenceCandidate struct {
	value         string
	taxID         string
	existingID    int64
	existingValue string
	existingTaxID string
	active        bool
}

func selectAIScanStoredCounterparty(value, taxID string, references []aiScanStoredCounterparty) (aiScanStoredCounterparty, bool) {
	taxID = normalizeAIScanTaxID(taxID)
	if taxID != "" {
		for _, reference := range references {
			if normalizeAIScanTaxID(reference.taxID) == taxID {
				return reference, true
			}
		}
	}
	key := normalizedPartyName(value)
	bestIndex, bestScore := -1, -1
	for index, reference := range references {
		if key == "" || normalizedPartyName(reference.value) != key {
			continue
		}
		if taxID != "" && reference.taxID != "" && normalizeAIScanTaxID(reference.taxID) != taxID {
			continue
		}
		score := aiScanReferenceNameQuality(reference.value, value)
		if reference.active {
			score += 20
		}
		if reference.taxID != "" {
			score += 5
		}
		if score > bestScore {
			bestIndex, bestScore = index, score
		}
	}
	if bestIndex < 0 && taxID != "" {
		bestSimilarity, secondSimilarity := 0.0, 0.0
		for index, reference := range references {
			if reference.taxID != "" && normalizeAIScanTaxID(reference.taxID) != taxID {
				continue
			}
			similarity := aiScanNormalizedNameSimilarity(value, reference.value)
			if similarity > bestSimilarity {
				bestIndex, secondSimilarity, bestSimilarity = index, bestSimilarity, similarity
			} else if similarity > secondSimilarity {
				secondSimilarity = similarity
			}
		}
		if bestSimilarity < 0.88 || bestSimilarity-secondSimilarity < 0.03 {
			bestIndex = -1
		}
	}
	if bestIndex < 0 {
		return aiScanStoredCounterparty{}, false
	}
	return references[bestIndex], true
}

func aiScanCounterpartyCandidateKey(value, taxID string) string {
	if taxID = normalizeAIScanTaxID(taxID); taxID != "" {
		return "tax:" + taxID
	}
	if key := normalizedPartyName(value); key != "" {
		return "name:" + key
	}
	return "value:" + strings.ToLower(strings.TrimSpace(value))
}

func syncAIScanCounterparties(ctx context.Context, tx *sql.Tx, items []aiScanCommitItem) (*undoChange, []aiScanReferenceAudit, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT id,value,COALESCE(tax_id,''),active
		FROM reference_values
		WHERE kind='counterparties'
		ORDER BY active DESC,sort_order,value,id
		FOR UPDATE`)
	if err != nil {
		return nil, nil, err
	}
	references := make([]aiScanStoredCounterparty, 0)
	for rows.Next() {
		var reference aiScanStoredCounterparty
		if err = rows.Scan(&reference.id, &reference.value, &reference.taxID, &reference.active); err != nil {
			rows.Close()
			return nil, nil, err
		}
		references = append(references, reference)
	}
	if err = rows.Close(); err != nil {
		return nil, nil, err
	}
	candidates := map[string]*aiScanReferenceCandidate{}
	order := make([]string, 0, len(items))
	for _, item := range items {
		value := strings.TrimSpace(item.Values.Counterparty)
		taxID := normalizeAIScanTaxID(item.CounterpartyTaxID)
		key := aiScanCounterpartyCandidateKey(value, taxID)
		if value == "" || candidates[key] != nil {
			continue
		}
		candidate := &aiScanReferenceCandidate{value: value, taxID: taxID}
		if existing, found := selectAIScanStoredCounterparty(value, taxID, references); found {
			candidate.existingID = existing.id
			candidate.existingValue = existing.value
			candidate.existingTaxID = existing.taxID
			candidate.active = existing.active
		}
		candidates[key] = candidate
		order = append(order, key)
	}

	changedExistingIDs := make([]int64, 0)
	for _, key := range order {
		candidate := candidates[key]
		if candidate.existingID > 0 && (!candidate.active || (candidate.taxID != "" && candidate.existingTaxID == "")) {
			changedExistingIDs = append(changedExistingIDs, candidate.existingID)
		}
	}
	before, err := snapshotRows(ctx, tx, "reference_values", changedExistingIDs)
	if err != nil {
		return nil, nil, err
	}

	changedIDs := make([]int64, 0)
	audits := make([]aiScanReferenceAudit, 0)
	canonical := map[string]string{}
	for _, key := range order {
		candidate := candidates[key]
		if candidate.existingID > 0 {
			canonical[key] = candidate.existingValue
			shouldBindTaxID := candidate.taxID != "" && candidate.existingTaxID == ""
			if !candidate.active || shouldBindTaxID {
				if _, err = tx.ExecContext(ctx, `UPDATE reference_values SET active=true,tax_id=CASE WHEN COALESCE(tax_id,'')='' THEN NULLIF($2,'') ELSE tax_id END WHERE id=$1`, candidate.existingID, candidate.taxID); err != nil {
					return nil, nil, err
				}
				changedIDs = append(changedIDs, candidate.existingID)
				audits = append(audits, aiScanReferenceAudit{ID: candidate.existingID, Value: candidate.existingValue, Reactivated: !candidate.active, TaxIDUpdated: shouldBindTaxID})
			}
			continue
		}
		var id int64
		var value string
		err = tx.QueryRowContext(ctx, `
			INSERT INTO reference_values(kind,value,sort_order,tax_id)
			VALUES('counterparties',$1,(SELECT COALESCE(max(sort_order),-1)+1 FROM reference_values WHERE kind='counterparties'),NULLIF($2,''))
			RETURNING id,value`, candidate.value, candidate.taxID).Scan(&id, &value)
		if err != nil {
			return nil, nil, err
		}
		canonical[key] = value
		changedIDs = append(changedIDs, id)
		audits = append(audits, aiScanReferenceAudit{ID: id, Value: value, Created: true})
	}
	for index := range items {
		key := aiScanCounterpartyCandidateKey(items[index].Values.Counterparty, items[index].CounterpartyTaxID)
		if value := canonical[key]; value != "" {
			items[index].Values.Counterparty = value
		}
	}
	if len(changedIDs) == 0 {
		return nil, nil, nil
	}
	after, err := snapshotRows(ctx, tx, "reference_values", changedIDs)
	if err != nil {
		return nil, nil, err
	}
	return &undoChange{Before: before, After: after}, audits, nil
}

func readAIScanBatch(token string) (string, aiScanBatchMeta, bool) {
	directory, ok := aiScanBatchDirectory(token)
	if !ok {
		return "", aiScanBatchMeta{}, false
	}
	data, err := os.ReadFile(filepath.Join(directory, "metadata.json"))
	var meta aiScanBatchMeta
	if err != nil || json.Unmarshal(data, &meta) != nil || meta.PageCount < 1 || meta.PageCount > maxAIScanPages || time.Since(meta.CreatedAt) > aiScanLifetime || (meta.Status != "processing" && meta.Status != "ready" && meta.Status != "error") {
		return "", aiScanBatchMeta{}, false
	}
	return directory, meta, true
}

func (a *app) serveAIScanPage(w http.ResponseWriter, r *http.Request) {
	directory, meta, ok := readAIScanBatch(r.PathValue("batch"))
	page, err := strconv.Atoi(r.PathValue("page"))
	if !ok || err != nil || page < 1 || page > meta.PageCount {
		fail(w, http.StatusNotFound, "Страница анализа не найдена")
		return
	}
	path := filepath.Join(directory, fmt.Sprintf("page-%03d.png", page))
	file, err := os.Open(path)
	if err != nil {
		fail(w, http.StatusNotFound, "Страница анализа не найдена")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusNotFound, "Страница анализа не найдена")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, fmt.Sprintf("page-%d.png", page), info.ModTime(), file)
}

func (a *app) commitAIScan(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("batch")
	directory, meta, ok := readAIScanBatch(token)
	if !ok {
		fail(w, http.StatusNotFound, "Результат анализа истёк. Загрузите документ повторно")
		return
	}
	if meta.Status != "ready" {
		fail(w, http.StatusConflict, "Распознавание ещё не завершено")
		return
	}
	var input struct {
		Items          []aiScanCommitItem `json:"items"`
		AllowDuplicate bool               `json:"allow_duplicate,omitempty"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Items) < 1 || len(input.Items) > meta.PageCount {
		fail(w, http.StatusBadRequest, "Выберите хотя бы один счёт")
		return
	}
	detectedByPage := make(map[int]aiScanSuggestion, len(meta.Items))
	for _, suggestion := range meta.Items {
		detectedByPage[suggestion.Page] = suggestion
	}
	seen := map[int]bool{}
	for index := range input.Items {
		item := &input.Items[index]
		if item.Page < 1 || item.Page > meta.PageCount || seen[item.Page] {
			fail(w, http.StatusBadRequest, "Некорректный список страниц")
			return
		}
		seen[item.Page] = true
		if detected := detectedByPage[item.Page]; detected.CounterpartyTaxID != "" && normalizedPartyName(detected.Counterparty) == normalizedPartyName(item.Values.Counterparty) {
			item.CounterpartyTaxID = detected.CounterpartyTaxID
		}
		if strings.TrimSpace(item.Values.Counterparty) == "" || strings.TrimSpace(item.Values.LegalEntity) == "" || strings.TrimSpace(item.Values.DocumentNumber) == "" || item.Values.DocumentDate == "" || item.Values.Amount == nil || *item.Values.Amount <= 0 {
			fail(w, http.StatusBadRequest, fmt.Sprintf("Заполните контрагента, юрлицо, документ, дату и сумму на странице %d", item.Page))
			return
		}
	}
	user := currentUser(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось начать сохранение")
		return
	}
	defer tx.Rollback()
	if err = acquireDuplicateWriteLock(r.Context(), tx); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось подготовить проверку дублей")
		return
	}
	referenceChange, referenceAudits, err := syncAIScanCounterparties(r.Context(), tx, input.Items)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось синхронизировать контрагентов со справочником")
		return
	}
	ids := make([]int64, 0, len(input.Items))
	scansSaved := false
	defer func() {
		if !scansSaved {
			for _, id := range ids {
				_ = removeObligationScan(id)
			}
		}
	}()
	entryDate := time.Now().Format("2006-01-02")
	for _, item := range input.Items {
		item.Values.EntryDate = entryDate
		item.Values.normalize()
		duplicates, duplicateErr := findDuplicateObligations(r.Context(), tx, item.Values, 0, "")
		if duplicateErr != nil {
			fail(w, http.StatusInternalServerError, fmt.Sprintf("Не удалось проверить страницу %d на дублирование", item.Page))
			return
		}
		if duplicates.Total > 0 && !input.AllowDuplicate {
			writeDuplicateConflict(w, duplicates, fmt.Sprintf("ai_scan_page_%d", item.Page))
			return
		}
		id, insertErr := insertObligation(r.Context(), tx, item.Values, &user.ID)
		if insertErr != nil {
			fail(w, http.StatusBadRequest, fmt.Sprintf("Не удалось сохранить страницу %d: %v", item.Page, insertErr))
			return
		}
		ids = append(ids, id)
		pageData, readErr := os.ReadFile(filepath.Join(directory, fmt.Sprintf("page-%03d.png", item.Page)))
		if readErr != nil {
			fail(w, http.StatusInternalServerError, fmt.Sprintf("Не удалось прикрепить скан страницы %d", item.Page))
			return
		}
		scanName := fmt.Sprintf("%s — страница %d.png", strings.TrimSuffix(meta.OriginalName, filepath.Ext(meta.OriginalName)), item.Page)
		if _, saveErr := saveObligationScan(id, scanName, pageData); saveErr != nil {
			fail(w, http.StatusInternalServerError, fmt.Sprintf("Не удалось прикрепить скан страницы %d", item.Page))
			return
		}
	}
	after, err := snapshotRows(r.Context(), tx, "obligations", ids)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "create", fmt.Sprintf("AI-сканирование: создание %d обязательств", len(ids)), undoPayload{Obligations: &undoChange{Before: emptySnapshot(), After: after}, References: referenceChange}) != nil {
		fail(w, http.StatusInternalServerError, "Не удалось записать историю операции")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось завершить сохранение")
		return
	}
	scansSaved = true
	for index, id := range ids {
		a.audit(r.Context(), user.ID, "create", "obligation", &id, map[string]any{"source": "ai_scan", "page": input.Items[index].Page, "batch": token})
	}
	createdReferences := 0
	for _, reference := range referenceAudits {
		if reference.Created {
			createdReferences++
		}
		action := "update"
		if reference.Created {
			action = "create"
		}
		a.audit(r.Context(), user.ID, action, "reference", &reference.ID, map[string]any{"kind": "counterparties", "value": reference.Value, "source": "ai_scan", "created": reference.Created, "reactivated": reference.Reactivated, "tax_id_updated": reference.TaxIDUpdated})
	}
	_ = os.RemoveAll(directory)
	writeJSON(w, http.StatusCreated, map[string]any{"created": len(ids), "created_references": createdReferences, "ids": ids})
}
