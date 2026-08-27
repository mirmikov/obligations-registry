package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	aiScanLearningVersion     = 1
	aiScanLearningStateKey    = "ai_scan_learning_v1"
	aiScanLearningMaximum     = 250
	aiScanLearningMaximumText = 2 << 20
)

var (
	aiScanLearningDatePattern = regexp.MustCompile(`(?i)[0-9]{1,2}(?:\s*[.\-/]\s*[0-9]{1,2}\s*[.\-/]\s*[0-9]{2,4}|\s+[А-Яа-яЁё]+\s+[0-9]{4})`)
	aiScanLearningStops       = map[string]bool{
		"для": true, "или": true, "при": true, "под": true, "над": true, "без": true, "это": true,
		"как": true, "так": true, "что": true, "все": true, "дата": true, "номер": true, "страница": true,
		"документ": true, "документа": true, "товар": true, "товары": true, "услуги": true, "руб": true,
	}
)

type aiScanLearningDocument struct {
	Page           int      `json:"page"`
	Pages          []int    `json:"pages"`
	Text           string   `json:"text"`
	TemplateTokens []string `json:"template_tokens"`
}

type aiScanLearningRule struct {
	Version        int      `json:"version"`
	Field          string   `json:"field"`
	Anchor         string   `json:"anchor,omitempty"`
	StaticValue    string   `json:"static_value,omitempty"`
	TaxID          string   `json:"tax_id,omitempty"`
	TemplateTokens []string `json:"template_tokens"`
	Support        int      `json:"support"`
	CreatedAt      string   `json:"created_at"`
}

func aiScanLearningDocuments(suggestions []aiScanSuggestion, pageTexts []string) []aiScanLearningDocument {
	result := make([]aiScanLearningDocument, 0, len(suggestions))
	for _, suggestion := range suggestions {
		pages := append([]int(nil), suggestion.Pages...)
		if len(pages) == 0 {
			pages = []int{suggestion.Page}
		}
		parts := make([]string, 0, len(pages))
		for _, page := range pages {
			if page > 0 && page <= len(pageTexts) && strings.TrimSpace(pageTexts[page-1]) != "" {
				parts = append(parts, pageTexts[page-1])
			}
		}
		text := strings.TrimSpace(strings.Join(parts, "\n"))
		if len(text) > aiScanLearningMaximumText {
			text = text[:aiScanLearningMaximumText]
		}
		result = append(result, aiScanLearningDocument{Page: suggestion.Page, Pages: pages, Text: text, TemplateTokens: aiScanLearningTemplateTokens(text)})
	}
	return result
}

func writeAIScanLearningDocuments(directory string, documents []aiScanLearningDocument) error {
	payload, err := json.Marshal(documents)
	if err != nil {
		return err
	}
	if len(payload) > 8<<20 {
		return fmt.Errorf("AI scan learning snapshot is too large")
	}
	temporary := filepath.Join(directory, "learning.json.tmp")
	if err = os.WriteFile(temporary, payload, 0640); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(directory, "learning.json"))
}

func readAIScanLearningDocuments(directory string) []aiScanLearningDocument {
	payload, err := os.ReadFile(filepath.Join(directory, "learning.json"))
	if err != nil || len(payload) > 8<<20 {
		return nil
	}
	var documents []aiScanLearningDocument
	if json.Unmarshal(payload, &documents) != nil {
		return nil
	}
	return documents
}

func aiScanLearningTemplateTokens(text string) []string {
	counts := map[string]int{}
	var token strings.Builder
	flush := func() {
		value := token.String()
		token.Reset()
		if len([]rune(value)) < 3 || aiScanLearningStops[value] {
			return
		}
		counts[value]++
	}
	for _, char := range foldAIScanText(text) {
		if unicode.IsLetter(char) {
			token.WriteRune(char)
		} else {
			flush()
		}
	}
	flush()
	type counted struct {
		value string
		count int
	}
	values := make([]counted, 0, len(counts))
	for value, count := range counts {
		values = append(values, counted{value: value, count: count})
	}
	sort.Slice(values, func(i, j int) bool {
		if values[i].count != values[j].count {
			return values[i].count > values[j].count
		}
		return values[i].value < values[j].value
	})
	if len(values) > 96 {
		values = values[:96]
	}
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = value.value
	}
	sort.Strings(result)
	return result
}

func aiScanLearningSimilarity(left, right []string) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	leftSet := make(map[string]struct{}, len(left))
	for _, value := range left {
		leftSet[value] = struct{}{}
	}
	intersection := 0
	union := len(leftSet)
	for _, value := range right {
		if _, ok := leftSet[value]; ok {
			intersection++
		} else {
			union++
		}
	}
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func aiScanLearningAnchor(field, line string) string {
	folded := foldAIScanText(line)
	markers := map[string][]string{
		"amount":          {"всего к оплате", "итого к оплате", "сумма к оплате", "стоимость товаров", "всего", "итого"},
		"document_number": {"универсальный передаточный документ", "счет фактура", "счет на оплату", "номер документа", "упд", "счет"},
		"document_date":   {"универсальный передаточный документ", "счет фактура", "счет на оплату", "дата документа", "упд", "счет"},
		"deferment_days":  {"условия оплаты", "дата оплаты", "срок оплаты", "оплатить не позднее", "оплата в течение", "отсрочка"},
	}
	for _, marker := range markers[field] {
		if strings.Contains(folded, marker) {
			return marker
		}
	}
	return ""
}

func aiScanLearningMoneyTokens(line string) []float64 {
	result := []float64{}
	for _, match := range aiAmountPattern.FindAllString(line, -1) {
		clean := strings.NewReplacer(" ", "", "\u00a0", "", ",", ".").Replace(match)
		value, err := strconv.ParseFloat(clean, 64)
		if err == nil && value > 0 {
			result = append(result, value)
		}
	}
	return result
}

func aiScanLearningDocumentCore(value string) string {
	if index := strings.LastIndex(value, "№"); index >= 0 {
		value = value[index+len("№"):]
	}
	return foldAIScanText(value)
}

func aiScanLearningCorrectedLine(field, corrected, text, documentDate string) (string, bool) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		anchor := aiScanLearningAnchor(field, line)
		if anchor == "" {
			continue
		}
		switch field {
		case "amount":
			wanted, err := strconv.ParseFloat(corrected, 64)
			if err != nil {
				continue
			}
			for _, value := range aiScanLearningMoneyTokens(line) {
				if math.Abs(value-wanted) < 0.005 {
					return line, true
				}
			}
		case "document_number":
			core := aiScanLearningDocumentCore(corrected)
			if core != "" && strings.Contains(foldAIScanText(line), core) {
				return line, true
			}
		case "document_date":
			for _, raw := range aiScanLearningDatePattern.FindAllString(line, -1) {
				if parseAIScanDate(raw) == corrected {
					return line, true
				}
			}
		case "deferment_days":
			wanted, err := strconv.Atoi(corrected)
			if err != nil {
				continue
			}
			if days, _, _ := extractAIScanDeferment(line, documentDate); days != nil && *days == wanted {
				return line, true
			}
			for _, token := range regexp.MustCompile(`\d{1,3}`).FindAllString(line, -1) {
				if value, _ := strconv.Atoi(token); value == wanted {
					return line, true
				}
			}
		}
	}
	return "", false
}

func aiScanLearningRuleForDynamic(field, corrected, text, documentDate string, tokens []string, now time.Time) (aiScanLearningRule, bool) {
	line, ok := aiScanLearningCorrectedLine(field, corrected, text, documentDate)
	if !ok {
		return aiScanLearningRule{}, false
	}
	anchor := aiScanLearningAnchor(field, line)
	if anchor == "" {
		return aiScanLearningRule{}, false
	}
	return aiScanLearningRule{Version: aiScanLearningVersion, Field: field, Anchor: anchor, TemplateTokens: append([]string(nil), tokens...), Support: 1, CreatedAt: now.UTC().Format(time.RFC3339)}, true
}

func aiScanLearningRulesForCommit(detectedByPage map[int]aiScanSuggestion, items []aiScanCommitItem, documents []aiScanLearningDocument, now time.Time) []aiScanLearningRule {
	documentByPage := make(map[int]aiScanLearningDocument, len(documents))
	for _, document := range documents {
		documentByPage[document.Page] = document
	}
	result := []aiScanLearningRule{}
	for _, item := range items {
		detected, exists := detectedByPage[item.Page]
		document, hasDocument := documentByPage[item.Page]
		if !exists || !hasDocument || strings.TrimSpace(document.Text) == "" {
			continue
		}
		addStatic := func(field, original, corrected string) {
			if strings.TrimSpace(corrected) == "" || normalizedPartyName(original) == normalizedPartyName(corrected) {
				return
			}
			result = append(result, aiScanLearningRule{Version: aiScanLearningVersion, Field: field, StaticValue: strings.TrimSpace(corrected), TemplateTokens: append([]string(nil), document.TemplateTokens...), Support: 1, CreatedAt: now.UTC().Format(time.RFC3339)})
		}
		addStatic("counterparty", detected.Counterparty, item.Values.Counterparty)
		addStatic("legal_entity", detected.LegalEntity, item.Values.LegalEntity)
		if foldAIScanText(detected.DocumentNumber) != foldAIScanText(item.Values.DocumentNumber) {
			if rule, ok := aiScanLearningRuleForDynamic("document_number", item.Values.DocumentNumber, document.Text, item.Values.DocumentDate, document.TemplateTokens, now); ok {
				result = append(result, rule)
			}
		}
		if detected.DocumentDate != item.Values.DocumentDate {
			if rule, ok := aiScanLearningRuleForDynamic("document_date", item.Values.DocumentDate, document.Text, item.Values.DocumentDate, document.TemplateTokens, now); ok {
				result = append(result, rule)
			}
		}
		if !sameMoney(detected.Amount, item.Values.Amount) && item.Values.Amount != nil {
			if rule, ok := aiScanLearningRuleForDynamic("amount", strconv.FormatFloat(*item.Values.Amount, 'f', 2, 64), document.Text, item.Values.DocumentDate, document.TemplateTokens, now); ok {
				result = append(result, rule)
			}
		}
		if (detected.DefermentDays == nil) != (item.Values.DefermentDays == nil) || detected.DefermentDays != nil && item.Values.DefermentDays != nil && *detected.DefermentDays != *item.Values.DefermentDays {
			if item.Values.DefermentDays != nil {
				if rule, ok := aiScanLearningRuleForDynamic("deferment_days", strconv.Itoa(*item.Values.DefermentDays), document.Text, item.Values.DocumentDate, document.TemplateTokens, now); ok {
					result = append(result, rule)
				}
			}
		}
	}
	return result
}

func aiScanLearningLine(text, anchor string) (string, bool) {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		if strings.Contains(foldAIScanText(line), anchor) {
			return line, true
		}
	}
	return "", false
}

func aiScanLearningExtract(rule aiScanLearningRule, text, documentDate string) (string, bool) {
	line, ok := aiScanLearningLine(text, rule.Anchor)
	if !ok {
		return "", false
	}
	switch rule.Field {
	case "amount":
		if value := parseAIScanAmountSegment(line); value != nil {
			return strconv.FormatFloat(*value, 'f', 2, 64), true
		}
	case "document_number", "document_date":
		value := parseAIScanTextWithReferences(line, nil, nil)
		if rule.Field == "document_number" && value.DocumentNumber != "" {
			return value.DocumentNumber, true
		}
		if rule.Field == "document_date" && value.DocumentDate != "" {
			return value.DocumentDate, true
		}
	case "deferment_days":
		if value, _, _ := extractAIScanDeferment(line, documentDate); value != nil {
			return strconv.Itoa(*value), true
		}
	}
	return "", false
}

func appendAIScanLearnedField(values []string, field string) []string {
	for _, value := range values {
		if value == field {
			return values
		}
	}
	return append(values, field)
}

func applyAIScanLearningRules(suggestion aiScanSuggestion, text string, rules []aiScanLearningRule) aiScanSuggestion {
	tokens := aiScanLearningTemplateTokens(text)
	type candidate struct {
		rule       aiScanLearningRule
		value      string
		similarity float64
	}
	best := map[string]candidate{}
	for _, rule := range rules {
		if !validAIScanLearningRule(rule) {
			continue
		}
		similarity := aiScanLearningSimilarity(tokens, rule.TemplateTokens)
		value := rule.StaticValue
		if rule.Anchor != "" {
			var ok bool
			value, ok = aiScanLearningExtract(rule, text, suggestion.DocumentDate)
			if !ok || similarity < 0.40 {
				continue
			}
		} else if similarity < 0.82 {
			continue
		}
		score := similarity + math.Min(float64(rule.Support), 5)*0.01
		if current, ok := best[rule.Field]; !ok || score > current.similarity+math.Min(float64(current.rule.Support), 5)*0.01 {
			best[rule.Field] = candidate{rule: rule, value: value, similarity: similarity}
		}
	}
	for field, candidate := range best {
		rule, value := candidate.rule, candidate.value
		switch field {
		case "counterparty":
			if looksLikeAIScanBankParty(value) || suggestion.Confidence[field] == "high" && suggestion.Counterparty != "" && rule.Support < 2 {
				continue
			}
			suggestion.Counterparty = value
			suggestion.CounterpartyTaxID = rule.TaxID
		case "legal_entity":
			if suggestion.Confidence[field] == "high" && suggestion.LegalEntity != "" && rule.Support < 2 {
				continue
			}
			suggestion.LegalEntity = value
		case "document_number":
			suggestion.DocumentNumber = value
		case "document_date":
			suggestion.DocumentDate = value
		case "amount":
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || parsed <= 0 {
				continue
			}
			suggestion.Amount = &parsed
		case "deferment_days":
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 0 || parsed > 730 {
				continue
			}
			suggestion.DefermentDays = intPointer(parsed)
		default:
			continue
		}
		if suggestion.Confidence == nil {
			suggestion.Confidence = map[string]string{}
		}
		suggestion.Confidence[field] = "high"
		suggestion.LearnedFields = appendAIScanLearnedField(suggestion.LearnedFields, field)
	}
	refreshAIScanWarnings(&suggestion)
	return suggestion
}

func validAIScanLearningRule(rule aiScanLearningRule) bool {
	allowed := map[string]bool{"counterparty": true, "legal_entity": true, "document_number": true, "document_date": true, "amount": true, "deferment_days": true}
	return rule.Version == aiScanLearningVersion && allowed[rule.Field] && len(rule.TemplateTokens) > 0 && len(rule.TemplateTokens) <= 96 && rule.Support > 0 && rule.Support <= 10000 && len(rule.Anchor) <= 80 && len(rule.StaticValue) <= 240 && (rule.Anchor != "" || rule.StaticValue != "")
}

func (a *app) loadAIScanLearningRules(ctx context.Context) []aiScanLearningRule {
	rows, err := a.db.QueryContext(ctx, `
		SELECT s.state->$1
		FROM user_workspace_state s
		JOIN users u ON u.id=s.user_id
		WHERE u.active AND jsonb_typeof(s.state->$1)='array'`, aiScanLearningStateKey)
	if err != nil {
		return nil
	}
	defer rows.Close()
	result := []aiScanLearningRule{}
	for rows.Next() {
		var raw json.RawMessage
		if rows.Scan(&raw) != nil {
			continue
		}
		var rules []aiScanLearningRule
		if json.Unmarshal(raw, &rules) != nil {
			continue
		}
		for _, rule := range rules {
			if validAIScanLearningRule(rule) {
				result = append(result, rule)
			}
		}
	}
	return mergeAIScanLearningRules(nil, result)
}

func aiScanLearningCompatible(left, right aiScanLearningRule) bool {
	return left.Field == right.Field && left.Anchor == right.Anchor && normalizedPartyName(left.StaticValue) == normalizedPartyName(right.StaticValue) && left.TaxID == right.TaxID && aiScanLearningSimilarity(left.TemplateTokens, right.TemplateTokens) >= 0.65
}

func aiScanLearningCommonTokens(left, right []string) []string {
	rightSet := map[string]bool{}
	for _, value := range right {
		rightSet[value] = true
	}
	result := []string{}
	for _, value := range left {
		if rightSet[value] {
			result = append(result, value)
		}
	}
	if len(result) < 8 {
		return append([]string(nil), right...)
	}
	return result
}

func mergeAIScanLearningRules(existing, additions []aiScanLearningRule) []aiScanLearningRule {
	result := append([]aiScanLearningRule(nil), existing...)
	for _, addition := range additions {
		if !validAIScanLearningRule(addition) {
			continue
		}
		merged := false
		for index := range result {
			if !aiScanLearningCompatible(result[index], addition) {
				continue
			}
			result[index].Support = min(10000, result[index].Support+max(1, addition.Support))
			result[index].TemplateTokens = aiScanLearningCommonTokens(result[index].TemplateTokens, addition.TemplateTokens)
			result[index].CreatedAt = addition.CreatedAt
			merged = true
			break
		}
		if !merged {
			result = append(result, addition)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].CreatedAt > result[j].CreatedAt })
	if len(result) > aiScanLearningMaximum {
		result = result[:aiScanLearningMaximum]
	}
	return result
}

func saveAIScanLearningRules(ctx context.Context, tx *sql.Tx, userID int64, additions []aiScanLearningRule) (int, error) {
	if len(additions) == 0 {
		return 0, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_workspace_state(user_id,state,updated_at) VALUES($1,'{}'::jsonb,now()) ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
		return 0, err
	}
	var raw json.RawMessage
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(state->$2,'[]'::jsonb) FROM user_workspace_state WHERE user_id=$1 FOR UPDATE`, userID, aiScanLearningStateKey).Scan(&raw); err != nil {
		return 0, err
	}
	var existing []aiScanLearningRule
	if len(raw) > 0 && json.Unmarshal(raw, &existing) != nil {
		existing = nil
	}
	merged := mergeAIScanLearningRules(existing, additions)
	payload, err := json.Marshal(merged)
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE user_workspace_state SET state=jsonb_set(COALESCE(state,'{}'::jsonb),ARRAY[$2],$3::jsonb,true),updated_at=now() WHERE user_id=$1`, userID, aiScanLearningStateKey, payload); err != nil {
		return 0, err
	}
	return len(additions), nil
}
