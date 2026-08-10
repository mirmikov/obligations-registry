package main

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const duplicateWriteLockKey = "obligations-registry:duplicate-check:v1"

type duplicateQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type duplicateMatch struct {
	ID                 int64    `json:"id"`
	SourceRow          int      `json:"source_row,omitempty"`
	Counterparty       string   `json:"counterparty"`
	LegalEntity        string   `json:"legal_entity"`
	DocumentNumber     string   `json:"document_number"`
	DocumentDate       string   `json:"document_date"`
	Amount             *float64 `json:"amount,omitempty"`
	PlannedPaymentDate string   `json:"planned_payment_date,omitempty"`
	Status             string   `json:"status,omitempty"`
	Confidence         string   `json:"confidence"`
	Reasons            []string `json:"reasons"`
}

type duplicateCheckResult struct {
	Matches []duplicateMatch `json:"duplicates"`
	Total   int              `json:"duplicate_total"`
}

type duplicateCandidate struct {
	id                 int64
	sourceRow          int
	counterparty       string
	legalEntity        string
	documentNumber     string
	documentDate       string
	amount             *float64
	plannedPaymentDate string
	status             string
	splitGroupID       string
}

type counterpartyIdentity struct {
	key   string
	taxID string
}

var (
	documentKindPrefix = regexp.MustCompile(`(?i)^\s*(?:универсальн(?:ый|ого)\s+передаточн(?:ый|ого)\s+документ|сч[её]т\s*[-–—]?\s*фактура|сч[её]т\s*[-–—]?\s*оферта|сч[её]т(?:\s+на\s+оплату)?|упд|товарная\s+накладная|накладная|акт(?:\s+(?:выполненных\s+работ|оказанных\s+услуг|при[её]ма\s*[-–—]?\s*передачи))?|договор)\s*`)
	documentDateSuffix = regexp.MustCompile(`(?i)\s+от\s+\d{1,2}(?:[./-]\d{1,2}[./-]\d{2,4}|\s+[а-яё]+\s+\d{4}).*$`)
)

func acquireDuplicateWriteLock(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, duplicateWriteLockKey)
	return err
}

func normalizedDocumentNumber(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "Ё", "Е")
	value = strings.ReplaceAll(value, "ё", "е")
	value = documentDateSuffix.ReplaceAllString(value, "")
	value = documentKindPrefix.ReplaceAllString(value, "")
	value = strings.TrimSpace(strings.TrimLeft(value, "№#NnНнoOоО.:-–— "))

	var result strings.Builder
	var digits strings.Builder
	flushDigits := func() {
		if digits.Len() == 0 {
			return
		}
		part := strings.TrimLeft(digits.String(), "0")
		if part == "" {
			part = "0"
		}
		result.WriteString(part)
		digits.Reset()
	}
	for _, r := range strings.ToUpper(value) {
		if unicode.IsDigit(r) {
			digits.WriteRune(r)
			continue
		}
		flushDigits()
		if unicode.IsLetter(r) {
			result.WriteRune(foldVisualLetter(r))
		}
	}
	flushDigits()
	return result.String()
}

func foldVisualLetter(r rune) rune {
	switch r {
	case 'А':
		return 'A'
	case 'В':
		return 'B'
	case 'Е':
		return 'E'
	case 'К':
		return 'K'
	case 'М':
		return 'M'
	case 'Н':
		return 'H'
	case 'О':
		return 'O'
	case 'Р':
		return 'P'
	case 'С':
		return 'C'
	case 'Т':
		return 'T'
	case 'У':
		return 'Y'
	case 'Х':
		return 'X'
	default:
		return r
	}
}

func normalizedPartyName(value string) string {
	value = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "ё", "е")
	for _, phrase := range []string{"общество с ограниченной ответственностью", "индивидуальный предприниматель", "публичное акционерное общество", "закрытое акционерное общество", "открытое акционерное общество", "акционерное общество"} {
		value = strings.ReplaceAll(value, phrase, " ")
	}
	ignored := map[string]bool{"ооо": true, "ип": true, "пао": true, "ао": true, "зао": true, "оао": true}
	var result strings.Builder
	var token strings.Builder
	flush := func() {
		if token.Len() == 0 {
			return
		}
		if !ignored[token.String()] {
			for _, r := range strings.ToUpper(token.String()) {
				result.WriteRune(foldVisualLetter(r))
			}
		}
		token.Reset()
	}
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			token.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return result.String()
}

func counterpartyIdentityFor(value string, taxIDs map[string]string) counterpartyIdentity {
	key := normalizedPartyName(value)
	return counterpartyIdentity{key: key, taxID: taxIDs[key]}
}

func sameCounterparty(left, right counterpartyIdentity) (bool, string) {
	if left.taxID != "" && right.taxID != "" && left.taxID == right.taxID {
		return true, "совпадает ИНН контрагента"
	}
	if left.key != "" && left.key == right.key {
		return true, "совпадает контрагент с учётом вариантов написания"
	}
	return false, ""
}

func sameMoney(left, right *float64) bool {
	return left != nil && right != nil && int64(math.Round(*left*100)) == int64(math.Round(*right*100))
}

func moneyChanged(left, right *float64) bool {
	if left == nil || right == nil {
		return left != nil || right != nil
	}
	return !sameMoney(left, right)
}

func dateDistance(left, right string) int {
	if left == "" || right == "" {
		return -1
	}
	leftTime, leftErr := timeParseDate(left)
	rightTime, rightErr := timeParseDate(right)
	if leftErr != nil || rightErr != nil {
		return -1
	}
	days := int(math.Abs(leftTime.Sub(rightTime).Hours()) / 24)
	return days
}

// Kept behind a helper so duplicate matching stays deterministic and easy to test.
func timeParseDate(value string) (time.Time, error) {
	return time.Parse("2006-01-02", value)
}

func evaluateDuplicate(input obligationInput, inputSplitGroup string, candidate duplicateCandidate, taxIDs map[string]string) (duplicateMatch, bool) {
	if inputSplitGroup != "" && inputSplitGroup == candidate.splitGroupID {
		return duplicateMatch{}, false
	}
	party, partyReason := sameCounterparty(counterpartyIdentityFor(input.Counterparty, taxIDs), counterpartyIdentityFor(candidate.counterparty, taxIDs))
	legal := normalizedPartyName(input.LegalEntity) != "" && normalizedPartyName(input.LegalEntity) == normalizedPartyName(candidate.legalEntity)
	document := normalizedDocumentNumber(input.DocumentNumber) != "" && normalizedDocumentNumber(input.DocumentNumber) == normalizedDocumentNumber(candidate.documentNumber)
	distance := dateDistance(input.DocumentDate, candidate.documentDate)
	dateExact := distance == 0
	dateNear := distance > 0 && distance <= 3
	amount := sameMoney(input.Amount, candidate.amount)

	confidence := ""
	switch {
	case party && legal && document && dateExact:
		confidence = "exact"
	case party && legal && dateExact && amount:
		confidence = "high"
	case party && legal && document && amount:
		confidence = "high"
	case legal && document && dateExact && amount:
		confidence = "high"
	case party && document && dateExact:
		confidence = "high"
	case document && dateExact && amount:
		confidence = "high"
	case party && legal && amount && dateNear:
		confidence = "possible"
	case party && document && amount && dateNear:
		confidence = "possible"
	default:
		return duplicateMatch{}, false
	}

	reasons := make([]string, 0, 5)
	if party {
		reasons = append(reasons, partyReason)
	}
	if legal {
		reasons = append(reasons, "совпадает юридическое лицо")
	}
	if document {
		reasons = append(reasons, "совпадает номер документа без учёта формата")
	}
	if dateExact {
		reasons = append(reasons, "совпадает дата документа")
	} else if dateNear {
		reasons = append(reasons, "дата документа отличается на 1–3 дня")
	}
	if amount {
		reasons = append(reasons, "совпадает сумма")
	} else if confidence == "exact" {
		reasons = append(reasons, "сумма отличается — проверьте исправление или повторный ввод")
	}
	return duplicateMatch{
		ID:                 candidate.id,
		SourceRow:          candidate.sourceRow,
		Counterparty:       candidate.counterparty,
		LegalEntity:        candidate.legalEntity,
		DocumentNumber:     candidate.documentNumber,
		DocumentDate:       candidate.documentDate,
		Amount:             candidate.amount,
		PlannedPaymentDate: candidate.plannedPaymentDate,
		Status:             candidate.status,
		Confidence:         confidence,
		Reasons:            reasons,
	}, true
}

func counterpartyTaxIDs(ctx context.Context, db duplicateQueryer) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT value,COALESCE(tax_id,'') FROM reference_values WHERE kind='counterparties'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var value, taxID string
		if err = rows.Scan(&value, &taxID); err != nil {
			return nil, err
		}
		if key := normalizedPartyName(value); key != "" && taxID != "" {
			result[key] = taxID
		}
	}
	return result, rows.Err()
}

func findDuplicateObligations(ctx context.Context, db duplicateQueryer, input obligationInput, excludeID int64, splitGroupID string) (duplicateCheckResult, error) {
	taxIDs, err := counterpartyTaxIDs(ctx, db)
	if err != nil {
		return duplicateCheckResult{}, err
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id,COALESCE(source_row,0),COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(document_number,''),
			COALESCE(to_char(document_date,'YYYY-MM-DD'),''),amount::float8,COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),
			COALESCE(status,''),COALESCE(split_group_id,'')
		FROM obligations WHERE ($1::bigint=0 OR id<>$1) ORDER BY id DESC`, excludeID)
	if err != nil {
		return duplicateCheckResult{}, err
	}
	defer rows.Close()
	matches := make([]duplicateMatch, 0)
	for rows.Next() {
		var candidate duplicateCandidate
		var amount sql.NullFloat64
		if err = rows.Scan(&candidate.id, &candidate.sourceRow, &candidate.counterparty, &candidate.legalEntity, &candidate.documentNumber, &candidate.documentDate, &amount, &candidate.plannedPaymentDate, &candidate.status, &candidate.splitGroupID); err != nil {
			return duplicateCheckResult{}, err
		}
		if amount.Valid {
			candidate.amount = &amount.Float64
		}
		if match, ok := evaluateDuplicate(input, splitGroupID, candidate, taxIDs); ok {
			matches = append(matches, match)
		}
	}
	if err = rows.Err(); err != nil {
		return duplicateCheckResult{}, err
	}
	sort.SliceStable(matches, func(left, right int) bool {
		levels := map[string]int{"exact": 0, "high": 1, "possible": 2}
		if levels[matches[left].Confidence] != levels[matches[right].Confidence] {
			return levels[matches[left].Confidence] < levels[matches[right].Confidence]
		}
		return matches[left].ID > matches[right].ID
	})
	total := len(matches)
	if len(matches) > 10 {
		matches = matches[:10]
	}
	return duplicateCheckResult{Matches: matches, Total: total}, nil
}

func loadDuplicateIdentity(ctx context.Context, tx *sql.Tx, id int64) (obligationInput, string, error) {
	var input obligationInput
	var amount sql.NullFloat64
	var splitGroupID string
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(counterparty,''),COALESCE(legal_entity,''),COALESCE(document_number,''),COALESCE(to_char(document_date,'YYYY-MM-DD'),''),amount::float8,COALESCE(split_group_id,'') FROM obligations WHERE id=$1 FOR UPDATE`, id).Scan(&input.Counterparty, &input.LegalEntity, &input.DocumentNumber, &input.DocumentDate, &amount, &splitGroupID)
	if amount.Valid {
		input.Amount = &amount.Float64
	}
	return input, splitGroupID, err
}

func duplicateIdentityChanged(before obligationInput, after obligationInput) bool {
	return normalizedPartyName(before.Counterparty) != normalizedPartyName(after.Counterparty) ||
		normalizedPartyName(before.LegalEntity) != normalizedPartyName(after.LegalEntity) ||
		normalizedDocumentNumber(before.DocumentNumber) != normalizedDocumentNumber(after.DocumentNumber) ||
		before.DocumentDate != after.DocumentDate || moneyChanged(before.Amount, after.Amount)
}

func writeDuplicateConflict(w http.ResponseWriter, result duplicateCheckResult, source string) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":           "Найден возможный дубликат счёта. Сравните реквизиты перед сохранением.",
		"code":            "duplicate_obligation",
		"source":          source,
		"duplicates":      result.Matches,
		"duplicate_total": result.Total,
	})
}
