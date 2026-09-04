package main

import (
	"bytes"
	"fmt"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	aiScanDocumentStartPattern  = regexp.MustCompile(`(?im)^\s*(?:сч[её]т(?:\s+на\s+оплату|\s*[-–—]\s*(?:договор|оферта|фактура))?|универсальный\s+передаточный\s+документ|упд|товарная\s+накладная|акт(?:\s+(?:выполненных\s+работ|оказанных\s+услуг))?)\b`)
	aiScanPaymentDaysPattern    = regexp.MustCompile(`(?i)(?:отсрочк[А-Яа-яЁёA-Za-z]*(?:\s+платежа)?|оплата|оплатить|постоплат[А-Яа-яЁёA-Za-z]*|срок\s+оплаты)[^\n]{0,120}?(\d{1,3})\s*(?:календарн[А-Яа-яЁёA-Za-z]*\s*)?(?:дн(?:ей|я|ь)|сут(?:ок|ки))`)
	aiScanDaysForPaymentPattern = regexp.MustCompile(`(?i)количеств[А-Яа-яЁёA-Za-z]*\s+дн(?:ей|я|ь)\s+для\s+оплат[А-Яа-яЁёA-Za-z]*\D{0,20}(\d{1,3})\b`)
	aiScanPaymentDatePattern    = regexp.MustCompile(`(?i)(?:дата\s+оплаты|оплата|оплатить|срок\s+оплаты|не\s+позднее|до)\D{0,45}([0-9]{1,2}(?:\s*[.\-/]\s*[0-9]{1,2}\s*[.\-/]\s*[0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4}))`)
	aiScanPaymentLinePattern    = regexp.MustCompile(`(?i)(?:услови[А-Яа-яЁёA-Za-z]*\s+оплаты|дата\s+оплаты|отсрочк[А-Яа-яЁёA-Za-z]*|постоплат[А-Яа-яЁёA-Za-z]*|предоплат[А-Яа-яЁёA-Za-z]*|срок\s+оплаты|оплатить\s+(?:в\s+течение|не\s+позднее|до)|оплата\s+(?:в\s+течение|не\s+позднее|до|через))`)
	aiScanWorkingDaysPattern    = regexp.MustCompile(`(?i)(?:рабоч[А-Яа-яЁёA-Za-z]*|банковск[А-Яа-яЁёA-Za-z]*)\s+(?:дн(?:ей|я|ь)|сут(?:ок|ки))`)
	aiScanPrepaymentPattern     = regexp.MustCompile(`(?i)(?:100\s*%\s*(?:предоплат[А-Яа-яЁёA-Za-z]*|аванс[А-Яа-яЁёA-Za-z]*)|(?:предоплат[А-Яа-яЁёA-Za-z]*|аванс[А-Яа-яЁёA-Za-z]*)\s*100\s*%|оплат[А-Яа-яЁёA-Za-z]*\s+до\s+(?:поставки|отгрузки))`)
)

func extractAIScanDeferment(text, documentDate string) (*int, string, string) {
	fallbackTerms := ""
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for _, raw := range lines {
		line := strings.Join(strings.Fields(raw), " ")
		if line == "" {
			continue
		}
		if match := aiScanDaysForPaymentPattern.FindStringSubmatch(line); len(match) == 2 {
			days, _ := strconv.Atoi(match[1])
			if days >= 0 && days <= 730 {
				return intPointer(days), line, "high"
			}
		}
		if !aiScanPaymentLinePattern.MatchString(line) {
			continue
		}
		if len([]rune(line)) > 320 {
			line = string([]rune(line)[:320])
		}
		if aiScanWorkingDaysPattern.MatchString(line) {
			// The registry adds deferment as calendar days. Do not silently turn
			// working or banking days into a wrong planned payment date.
			if fallbackTerms == "" {
				fallbackTerms = line
			}
			continue
		}
		if match := aiScanPaymentDaysPattern.FindStringSubmatch(line); len(match) == 2 {
			days, _ := strconv.Atoi(match[1])
			if days >= 0 && days <= 730 {
				return intPointer(days), line, "high"
			}
		}
		if match := aiScanPaymentDatePattern.FindStringSubmatch(line); len(match) == 2 && documentDate != "" {
			dueDate := parseAIScanDate(match[1])
			document, documentErr := time.Parse("2006-01-02", documentDate)
			due, dueErr := time.Parse("2006-01-02", dueDate)
			if documentErr == nil && dueErr == nil {
				days := int(due.Sub(document).Hours() / 24)
				if days >= 0 && days <= 730 {
					return intPointer(days), line, "high"
				}
			}
		}
		if aiScanPrepaymentPattern.MatchString(line) {
			return intPointer(0), line, "high"
		}
		// Preserve a complex schedule or an unreadable payment condition for the
		// accountant even when it cannot be safely reduced to calendar days.
		if fallbackTerms == "" {
			fallbackTerms = line
		}
	}
	if fallbackTerms != "" {
		return nil, fallbackTerms, "low"
	}
	return nil, "", ""
}

func intPointer(value int) *int { return &value }

func aiScanDocumentIdentity(value aiScanSuggestion) string {
	if aiScanConfidenceRank(value.Confidence["document_number"]) < aiScanConfidenceRank("medium") {
		return ""
	}
	return foldAIScanText(value.DocumentNumber)
}

func shouldStartNewAIScanDocument(current, next aiScanSuggestion, pageText string) bool {
	currentIdentity := aiScanDocumentIdentity(current)
	nextIdentity := aiScanDocumentIdentity(next)
	if currentIdentity != "" && nextIdentity != "" {
		return currentIdentity != nextIdentity
	}
	if nextIdentity != "" {
		return true
	}
	return aiScanDocumentStartPattern.MatchString(pageText)
}

func isMegafonAIScanBillingStart(text string) bool {
	folded := foldAIScanText(text)
	return (strings.Contains(folded, "мегафон") || strings.Contains(folded, "megafon")) &&
		strings.Contains(folded, "расчетный период") && strings.Contains(folded, "лицевой счет") &&
		strings.Contains(folded, "оператор") && strings.Contains(folded, "абонент")
}

func megafonAIScanAccount(text string) string {
	folded := foldAIScanText(text)
	marker := strings.Index(folded, "лицевой счет")
	if marker < 0 {
		return ""
	}
	segment := []rune(folded[marker+len("лицевой счет"):])
	if len(segment) > 80 {
		segment = segment[:80]
	}
	var digits strings.Builder
	for _, character := range segment {
		if character >= '0' && character <= '9' {
			digits.WriteRune(character)
			continue
		}
		if digits.Len() >= 8 {
			break
		}
		if digits.Len() > 0 && character != ' ' && character != '-' && character != ':' {
			digits.Reset()
		}
	}
	if digits.Len() < 8 || digits.Len() > 20 {
		return ""
	}
	return digits.String()
}

func shouldContinueMegafonAIScanBilling(firstPageText, nextPageText string) bool {
	if !isMegafonAIScanBillingStart(firstPageText) || isMegafonAIScanBillingStart(nextPageText) {
		return false
	}
	folded := foldAIScanText(nextPageText)
	if strings.Contains(folded, "мегафон") || strings.Contains(folded, "megafon") {
		return true
	}
	account := megafonAIScanAccount(firstPageText)
	if account == "" {
		return false
	}
	var nextDigits strings.Builder
	for _, character := range nextPageText {
		if character >= '0' && character <= '9' {
			nextDigits.WriteRune(character)
		}
	}
	return strings.Contains(nextDigits.String(), account)
}

func groupAIScanDocumentSuggestions(perPage []aiScanSuggestion, pageTexts []string) []aiScanSuggestion {
	groups := make([]aiScanSuggestion, 0, len(perPage))
	for index, suggestion := range perPage {
		page := index + 1
		suggestion.Page = page
		suggestion.Pages = []int{page}
		continueMegafonPacket := false
		if len(groups) > 0 && len(groups[len(groups)-1].Pages) > 0 {
			firstPage := groups[len(groups)-1].Pages[0]
			if firstPage > 0 && firstPage <= len(pageTexts) {
				continueMegafonPacket = shouldContinueMegafonAIScanBilling(pageTexts[firstPage-1], valueAt(pageTexts, index))
			}
		}
		if len(groups) == 0 || (!continueMegafonPacket && shouldStartNewAIScanDocument(groups[len(groups)-1], suggestion, valueAt(pageTexts, index))) {
			groups = append(groups, suggestion)
			continue
		}
		group := groups[len(groups)-1]
		pages := append(append([]int(nil), group.Pages...), page)
		persistentWarnings := appendAIScanPersistentWarnings(nil, group.Warnings...)
		persistentWarnings = appendAIScanPersistentWarnings(persistentWarnings, suggestion.Warnings...)
		merged := mergeAIScanSuggestions(group, suggestion)
		// In a multi-page invoice the final payable total is normally printed on
		// the last page. Prefer the last confident amount over a page subtotal.
		if suggestion.Amount != nil && aiScanConfidenceRank(suggestion.Confidence["amount"]) >= aiScanConfidenceRank("medium") {
			merged.Amount = suggestion.Amount
			merged.Confidence["amount"] = suggestion.Confidence["amount"]
		}
		merged.Page = pages[0]
		merged.Pages = pages
		refreshAIScanWarnings(&merged)
		merged.Warnings = appendAIScanPersistentWarnings(merged.Warnings, persistentWarnings...)
		groups[len(groups)-1] = merged
	}
	// Re-evaluate terms after grouping. UTDs commonly put the document date on
	// page one and the payable date on the final page, so per-page parsing cannot
	// safely calculate deferment.
	for index := range groups {
		persistentWarnings := appendAIScanPersistentWarnings(nil, groups[index].Warnings...)
		parts := make([]string, 0, len(groups[index].Pages))
		for _, page := range groups[index].Pages {
			if page > 0 && page <= len(pageTexts) {
				parts = append(parts, pageTexts[page-1])
			}
		}
		if days, terms, confidence := extractAIScanDeferment(strings.Join(parts, "\n"), groups[index].DocumentDate); days != nil {
			groups[index].DefermentDays = days
			groups[index].PaymentTerms = terms
			groups[index].Confidence["deferment_days"] = confidence
		} else if groups[index].PaymentTerms == "" && terms != "" {
			groups[index].PaymentTerms = terms
			groups[index].Confidence["deferment_days"] = confidence
		}
		refreshAIScanWarnings(&groups[index])
		groups[index].Warnings = appendAIScanPersistentWarnings(groups[index].Warnings, persistentWarnings...)
	}
	return groups
}

func appendAIScanPersistentWarnings(target []string, values ...string) []string {
	for _, value := range values {
		if value == "" || strings.HasPrefix(value, "Не распознано поле:") || value == "Условия оплаты распознаны, но отсрочку нужно проверить вручную" {
			continue
		}
		found := false
		for _, existing := range target {
			if existing == value {
				found = true
				break
			}
		}
		if !found {
			target = append(target, value)
		}
	}
	return target
}

func normalizedAIScanPages(value aiScanSuggestion, total int) ([]int, error) {
	pages := append([]int(nil), value.Pages...)
	if len(pages) == 0 {
		pages = []int{value.Page}
	}
	for index, page := range pages {
		if page < 1 || page > total || (index > 0 && page != pages[index-1]+1) {
			return nil, fmt.Errorf("invalid AI scan page group")
		}
	}
	return pages, nil
}

func readAIScanDocumentAttachment(directory, originalName string, totalPages int, value aiScanSuggestion) (string, []byte, error) {
	pages, err := normalizedAIScanPages(value, totalPages)
	if err != nil {
		return "", nil, err
	}
	baseName := strings.TrimSuffix(originalName, filepath.Ext(originalName))
	if len(pages) == 1 {
		data, readErr := os.ReadFile(filepath.Join(directory, fmt.Sprintf("page-%03d.png", pages[0])))
		return fmt.Sprintf("%s — страница %d.png", baseName, pages[0]), data, readErr
	}
	if len(pages) == totalPages && pages[0] == 1 {
		if data, readErr := os.ReadFile(filepath.Join(directory, "source.pdf")); readErr == nil {
			return cleanObligationScanName(originalName, ".pdf"), data, nil
		}
	}
	paths := make([]string, 0, len(pages))
	for _, page := range pages {
		paths = append(paths, filepath.Join(directory, fmt.Sprintf("page-%03d.png", page)))
	}
	pdf, err := buildAIScanImagePDF(paths)
	if err != nil {
		return "", nil, err
	}
	return fmt.Sprintf("%s — страницы %d-%d.pdf", baseName, pages[0], pages[len(pages)-1]), pdf, nil
}

func buildAIScanImagePDF(paths []string) ([]byte, error) {
	type pageAsset struct {
		width, height int
		jpeg          []byte
	}
	assets := make([]pageAsset, 0, len(paths))
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		imageValue, decodeErr := png.Decode(file)
		_ = file.Close()
		if decodeErr != nil {
			return nil, decodeErr
		}
		var encoded bytes.Buffer
		if err = jpeg.Encode(&encoded, imageValue, &jpeg.Options{Quality: 90}); err != nil {
			return nil, err
		}
		assets = append(assets, pageAsset{width: imageValue.Bounds().Dx(), height: imageValue.Bounds().Dy(), jpeg: encoded.Bytes()})
	}
	if len(assets) == 0 {
		return nil, fmt.Errorf("empty AI scan document")
	}

	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	objectCount := 2 + len(assets)*3
	offsets := make([]int, objectCount+1)
	writeObject := func(id int, body []byte) {
		offsets[id] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n", id)
		output.Write(body)
		output.WriteString("\nendobj\n")
	}
	writeObject(1, []byte("<< /Type /Catalog /Pages 2 0 R >>"))
	var kids strings.Builder
	for index := range assets {
		fmt.Fprintf(&kids, "%d 0 R ", 3+index*3)
	}
	writeObject(2, []byte(fmt.Sprintf("<< /Type /Pages /Count %d /Kids [%s] >>", len(assets), kids.String())))
	for index, asset := range assets {
		pageObject := 3 + index*3
		imageObject := pageObject + 1
		contentObject := pageObject + 2
		widthPoints := float64(asset.width) * 72 / aiScanDPI
		heightPoints := float64(asset.height) * 72 / aiScanDPI
		writeObject(pageObject, []byte(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>", widthPoints, heightPoints, imageObject, contentObject)))
		imageBody := bytes.NewBuffer(nil)
		fmt.Fprintf(imageBody, "<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n", asset.width, asset.height, len(asset.jpeg))
		imageBody.Write(asset.jpeg)
		imageBody.WriteString("\nendstream")
		writeObject(imageObject, imageBody.Bytes())
		content := []byte(fmt.Sprintf("q\n%.2f 0 0 %.2f 0 0 cm\n/Im0 Do\nQ\n", widthPoints, heightPoints))
		contentBody := []byte(fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content))
		writeObject(contentObject, contentBody)
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", objectCount+1)
	for id := 1; id <= objectCount; id++ {
		fmt.Fprintf(&output, "%010d 00000 n \n", offsets[id])
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", objectCount+1, xref)
	return output.Bytes(), nil
}
