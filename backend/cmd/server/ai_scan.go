package main

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	maxAIScanPages = 30
	aiScanLifetime = 24 * time.Hour
	aiScanDPI      = 140
)

type aiScanBatchMeta struct {
	OriginalName string             `json:"original_name"`
	CreatedAt    time.Time          `json:"created_at"`
	PageCount    int                `json:"page_count"`
	Status       string             `json:"status"`
	Error        string             `json:"error,omitempty"`
	Items        []aiScanSuggestion `json:"items,omitempty"`
}

type aiScanSuggestion struct {
	Page           int               `json:"page"`
	Counterparty   string            `json:"counterparty"`
	LegalEntity    string            `json:"legal_entity"`
	DocumentNumber string            `json:"document_number"`
	DocumentDate   string            `json:"document_date"`
	Amount         *float64          `json:"amount"`
	Duplicate      bool              `json:"duplicate"`
	Confidence     map[string]string `json:"confidence"`
	Warnings       []string          `json:"warnings"`
}

type aiScanCommitItem struct {
	Page   int             `json:"page"`
	Values obligationInput `json:"values"`
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
	ocrTexts, ocrErrors := recognizeAIScanPages(ctx, pages, directory)
	suggestions := make([]aiScanSuggestion, 0, len(pages))
	for index, text := range ocrTexts {
		ocrErr := ocrErrors[index]
		if ocrErr != nil {
			log.Printf("AI scan OCR page %d: %v", index+1, ocrErr)
		}
		suggestion := parseAIScanText(text, counterparties, legalEntities)
		// Dense tables and low-contrast invoice headers occasionally confuse the
		// automatic layout detector. Retry only pages whose document header is
		// missing, using a single-block layout, so normal multi-page batches stay
		// fast while weak scans get one focused recovery attempt.
		if suggestion.DocumentNumber == "" || suggestion.DocumentDate == "" {
			if fallback, fallbackErr := runTesseractWithPSM(ctx, pages[index], "6"); fallbackErr == nil && strings.TrimSpace(fallback) != "" {
				suggestion = parseAIScanText(text+"\n"+fallback, counterparties, legalEntities)
			}
		}
		suggestion.Page = index + 1
		suggestion.Duplicate = a.aiScanDuplicate(ctx, suggestion)
		if ocrErr != nil {
			suggestion.Warnings = append(suggestion.Warnings, "Страница распознана не полностью — проверьте значения вручную")
		}
		suggestions = append(suggestions, suggestion)
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

func recognizeAIScanPages(ctx context.Context, pages []string, directory string) ([]string, []error) {
	texts := make([]string, len(pages))
	errorsByPage := make([]error, len(pages))
	jobs := make(chan int)
	workerCount := 2
	if len(pages) < workerCount {
		workerCount = len(pages)
	}
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for worker := 0; worker < workerCount; worker++ {
		go func() {
			defer workers.Done()
			for index := range jobs {
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

func prepareAIScanPages(ctx context.Context, inputPath, contentType, directory string) ([]string, error) {
	if contentType != "application/pdf" {
		pagePath := filepath.Join(directory, "page-001.png")
		if err := convertImageToPNG(inputPath, pagePath, 0); err != nil {
			return nil, err
		}
		return []string{pagePath}, nil
	}
	prefix := filepath.Join(directory, "rendered")
	cmd := exec.CommandContext(ctx, "pdftoppm", "-png", "-r", strconv.Itoa(aiScanDPI), "-f", "1", "-l", strconv.Itoa(maxAIScanPages+1), inputPath, prefix)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pdftoppm: %w: %s", err, strings.TrimSpace(stderr.String()))
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
	pageCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	cmd := exec.CommandContext(pageCtx, "tesseract", imagePath, "stdout", "-l", "rus+eng", "--psm", pageSegmentationMode, "--dpi", strconv.Itoa(aiScanDPI))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.String(), fmt.Errorf("tesseract: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
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
	for _, marker := range []string{"счет", "оплату", "поставщик", "покупатель", "инн", "итого"} {
		if strings.Contains(folded, marker) {
			score += 25
		}
	}
	return score
}

var (
	aiDocumentPattern = regexp.MustCompile(`(?i)(сч[её]т(?:\s+на\s+опл\s*ату)?)\s*(?:№|N|No)?\s*([0-9A-Za-zА-Яа-яЁё./_-]+)\s+от\s+([0-9]{1,2}(?:[.\-/][0-9]{1,2}[.\-/][0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4}))`)
	aiAmountPattern   = regexp.MustCompile(`[0-9]{1,3}(?:[ \x{00A0}][0-9]{3})*(?:[,.][0-9]{2})|[0-9]+(?:[,.][0-9]{2})|[0-9]+`)
	aiSupplierPattern = regexp.MustCompile(`(?is)поставщик(?:\s*\([^)]*\))?\s*[:;]?\s*(.{3,260}?)(?:покупатель|заказчик|основание|товары|услуги)`)
	aiBuyerPattern    = regexp.MustCompile(`(?is)(?:покупатель|заказчик)(?:\s*\([^)]*\))?\s*[:;]?\s*(.{3,260}?)(?:основание|товары|услуги|поставщик)`)
)

var aiMonths = map[string]int{"января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6, "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12}

func parseAIScanText(text string, counterparties, legalEntities []string) aiScanSuggestion {
	result := aiScanSuggestion{Confidence: map[string]string{}, Warnings: []string{}}
	match := aiDocumentPattern.FindStringSubmatch(text)
	if len(match) == 4 {
		documentKind := strings.Join(strings.Fields(match[1]), " ")
		documentKind = regexp.MustCompile(`(?i)опл\s+ату`).ReplaceAllString(documentKind, "оплату")
		result.DocumentNumber = documentKind + " № " + strings.TrimSpace(match[2])
		result.DocumentDate = parseAIScanDate(match[3])
		result.Confidence["document_number"] = "high"
		if result.DocumentDate != "" {
			result.Confidence["document_date"] = "high"
		}
	}
	result.Amount = parseAIScanAmount(text)
	if result.Amount != nil {
		result.Confidence["amount"] = "high"
	}
	supplierText := regexpCapture(aiSupplierPattern, text)
	buyerText := regexpCapture(aiBuyerPattern, text)
	result.Counterparty, result.Confidence["counterparty"] = bestAIScanReference(supplierText+" "+text, counterparties)
	if result.Counterparty == "" {
		result.Counterparty = extractAIScanParty(supplierText)
		if result.Counterparty != "" {
			result.Confidence["counterparty"] = "low"
		}
	}
	result.LegalEntity, result.Confidence["legal_entity"] = bestAIScanReference(buyerText+" "+text, legalEntities)
	if result.LegalEntity == "" {
		result.LegalEntity = extractAIScanParty(buyerText)
		if result.LegalEntity != "" {
			result.Confidence["legal_entity"] = "low"
		}
	}
	for field, label := range map[string]string{"counterparty": "контрагент", "legal_entity": "юридическое лицо", "document_number": "номер документа", "document_date": "дата документа", "amount": "сумма"} {
		missing := (field == "amount" && result.Amount == nil) || (field == "counterparty" && result.Counterparty == "") || (field == "legal_entity" && result.LegalEntity == "") || (field == "document_number" && result.DocumentNumber == "") || (field == "document_date" && result.DocumentDate == "")
		if missing {
			result.Warnings = append(result.Warnings, "Не распознано поле: "+label)
		}
	}
	return result
}

func regexpCapture(pattern *regexp.Regexp, text string) string {
	match := pattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func parseAIScanDate(value string) string {
	value = strings.TrimSpace(strings.ToLower(strings.ReplaceAll(value, "ё", "е")))
	if match := regexp.MustCompile(`^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$`).FindStringSubmatch(value); len(match) == 4 {
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
	if index := regexp.MustCompile(`(?i)[,;]\s*(?:ИНН|КПП|адрес)`).FindStringIndex(value); index != nil {
		value = value[:index[0]]
	}
	value = strings.Trim(value, " ,;:-")
	if len([]rune(value)) > 140 {
		return ""
	}
	return value
}

func (a *app) aiScanReferences(ctx context.Context) ([]string, []string, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT kind,value FROM reference_values WHERE active AND kind IN ('counterparties','legal_entities') ORDER BY kind,sort_order,value`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var counterparties, legalEntities []string
	for rows.Next() {
		var kind, value string
		if err = rows.Scan(&kind, &value); err != nil {
			return nil, nil, err
		}
		if kind == "counterparties" {
			counterparties = append(counterparties, value)
		} else {
			legalEntities = append(legalEntities, value)
		}
	}
	return counterparties, legalEntities, rows.Err()
}

func (a *app) aiScanDuplicate(ctx context.Context, item aiScanSuggestion) bool {
	if item.Counterparty == "" || item.DocumentNumber == "" || item.DocumentDate == "" || item.Amount == nil {
		return false
	}
	var exists bool
	err := a.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM obligations WHERE lower(COALESCE(counterparty,''))=lower($1) AND COALESCE(document_number,'')=$2 AND document_date=$3::date AND amount=$4)`, item.Counterparty, item.DocumentNumber, item.DocumentDate, *item.Amount).Scan(&exists)
	return err == nil && exists
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
		Items []aiScanCommitItem `json:"items"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Items) < 1 || len(input.Items) > meta.PageCount {
		fail(w, http.StatusBadRequest, "Выберите хотя бы один счёт")
		return
	}
	seen := map[int]bool{}
	for _, item := range input.Items {
		if item.Page < 1 || item.Page > meta.PageCount || seen[item.Page] {
			fail(w, http.StatusBadRequest, "Некорректный список страниц")
			return
		}
		seen[item.Page] = true
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
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "create", fmt.Sprintf("AI-сканирование: создание %d обязательств", len(ids)), undoPayload{Obligations: &undoChange{Before: emptySnapshot(), After: after}}) != nil {
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
	_ = os.RemoveAll(directory)
	writeJSON(w, http.StatusCreated, map[string]any{"created": len(ids), "ids": ids})
}
