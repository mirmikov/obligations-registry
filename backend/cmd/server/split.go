package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxInstallments = 60

type paymentSplitInput struct {
	Mode            string                       `json:"mode"`
	Count           int                          `json:"count"`
	StartDate       string                       `json:"start_date"`
	PaymentDates    []string                     `json:"payment_dates"`
	AmountParts     []paymentSplitAmountPart     `json:"amount_parts"`
	PercentageParts []paymentSplitPercentagePart `json:"percentage_parts"`
}

type paymentSplitAmountPart struct {
	Amount      json.Number `json:"amount"`
	AccountType string      `json:"account_type"`
	PlannedDate string      `json:"planned_date"`
}

type paymentSplitPercentagePart struct {
	Percent     json.Number `json:"percent"`
	AccountType string      `json:"account_type"`
	PlannedDate string      `json:"planned_date"`
}

type paymentInstallment struct {
	Number      int     `json:"number"`
	Date        string  `json:"date"`
	Amount      float64 `json:"amount"`
	Percent     float64 `json:"percent,omitempty"`
	AccountType string  `json:"account_type,omitempty"`
	cents       int64
	basisPoints int64
}

func (a *app) splitObligation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 400, "Некорректный ID")
		return
	}
	input := paymentSplitInput{}
	if !decodeJSON(w, r, &input) {
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "Не удалось начать разбиение платежа")
		return
	}
	defer tx.Rollback()

	var amountText, plannedDate, status, actualDate, existingGroup, accountType string
	var existingCount int
	err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(amount::text,''),COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),COALESCE(status,''),COALESCE(to_char(actual_payment_date,'YYYY-MM-DD'),''),COALESCE(split_group_id,''),COALESCE(installment_count,0),COALESCE(account_type,'') FROM obligations WHERE id=$1 FOR UPDATE`, id).Scan(&amountText, &plannedDate, &status, &actualDate, &existingGroup, &existingCount, &accountType)
	if err != nil {
		fail(w, 404, "Платёж не найден")
		return
	}
	beforeRow, err := snapshotOneObligation(r.Context(), tx, id)
	if err != nil {
		fail(w, 500, "Не удалось подготовить историю отмены")
		return
	}
	before, _ := snapshotArray([]json.RawMessage{beforeRow})
	if existingGroup != "" || existingCount > 1 {
		fail(w, 400, "Этот платёж уже является частью графика")
		return
	}
	if status == "Оплачено" || status == "Отменено" || actualDate != "" {
		fail(w, 400, "Оплаченный или отменённый платёж нельзя разбить")
		return
	}

	totalCents, err := moneyTextToCents(amountText)
	if err != nil || totalCents <= 0 {
		fail(w, 400, "У платежа должна быть положительная сумма")
		return
	}
	if input.StartDate == "" {
		input.StartDate = plannedDate
	}
	if input.StartDate == "" {
		input.StartDate = time.Now().Format("2006-01-02")
	}
	startDate, err := time.Parse("2006-01-02", input.StartDate)
	if err != nil {
		fail(w, 400, "Некорректная дата первого платежа")
		return
	}
	plan, err := buildPaymentPlan(totalCents, startDate, input)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	for index := range plan {
		if strings.TrimSpace(plan[index].AccountType) == "" {
			plan[index].AccountType = accountType
		}
	}

	groupID, err := newSplitGroupID()
	if err != nil {
		fail(w, 500, "Не удалось создать идентификатор графика")
		return
	}
	user := currentUser(r)
	first := plan[0]
	_, err = tx.ExecContext(r.Context(), `UPDATE obligations SET account_type=$1,amount=$2::numeric,planned_payment_date=$3::date,split_group_id=$4,split_parent_id=NULL,installment_number=1,installment_count=$5,updated_by=$6,updated_at=now() WHERE id=$7`, nullable(first.AccountType), formatCents(first.cents), first.Date, groupID, len(plan), user.ID, id)
	if err != nil {
		fail(w, 500, "Не удалось сохранить первый платёж")
		return
	}

	createdIDs := []int64{}
	for _, installment := range plan[1:] {
		var childID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO obligations(source_row,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,amount,planned_payment_date,approval_date,actual_payment_date,status,urgency,comment,source_note,created_by,updated_by,split_group_id,split_parent_id,installment_number,installment_count)
			SELECT NULL,$1,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,$2::numeric,$3::date,approval_date,NULL,status,urgency,comment,source_note,$4,$4,$5,$6,$7,$8
			FROM obligations WHERE id=$9 RETURNING id`, nullable(installment.AccountType), formatCents(installment.cents), installment.Date, user.ID, groupID, id, installment.Number, len(plan), id).Scan(&childID)
		if err != nil {
			fail(w, 500, "Не удалось создать часть платежа")
			return
		}
		createdIDs = append(createdIDs, childID)
	}
	afterIDs := append([]int64{id}, createdIDs...)
	after, err := snapshotRows(r.Context(), tx, "obligations", afterIDs)
	if err != nil || a.recordUndo(r.Context(), tx, user.ID, "split", fmt.Sprintf("Разбиение обязательства №%d на %d частей", id, len(plan)), undoPayload{Obligations: &undoChange{Before: before, After: after}}) != nil {
		fail(w, 500, "Не удалось записать историю отмены")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "Не удалось завершить разбиение платежа")
		return
	}

	a.audit(r.Context(), user.ID, "split", "obligation", &id, map[string]any{"group_id": groupID, "original_amount": formatCents(totalCents), "installments": plan, "created_ids": createdIDs})
	writeJSON(w, 200, map[string]any{"group_id": groupID, "original_id": id, "created_ids": createdIDs, "installments": plan})
}

func buildPaymentPlan(totalCents int64, startDate time.Time, input paymentSplitInput) ([]paymentInstallment, error) {
	if totalCents <= 0 {
		return nil, errors.New("Сумма должна быть больше нуля")
	}
	if input.Mode == "percentage" {
		return buildPercentagePaymentPlan(totalCents, startDate, input.PercentageParts)
	}
	if input.Mode == "amount" {
		return buildFixedAmountPaymentPlan(totalCents, input.AmountParts)
	}
	amounts := []int64{}
	switch input.Mode {
	case "count", "":
		if input.Count < 2 || input.Count > maxInstallments {
			return nil, fmt.Errorf("Количество платежей должно быть от 2 до %d", maxInstallments)
		}
		base := totalCents / int64(input.Count)
		if base < 1 {
			return nil, errors.New("Сумма слишком мала для выбранного количества платежей")
		}
		for index := 0; index < input.Count-1; index++ {
			amounts = append(amounts, base)
		}
		amounts = append(amounts, totalCents-base*int64(input.Count-1))
	default:
		return nil, errors.New("Выберите способ разбиения")
	}

	if len(input.PaymentDates) != len(amounts) {
		return nil, errors.New("Количество дат в графике должно совпадать с количеством платежей")
	}
	plan := make([]paymentInstallment, 0, len(amounts))
	for index, cents := range amounts {
		date, parseErr := time.Parse("2006-01-02", input.PaymentDates[index])
		if parseErr != nil {
			return nil, fmt.Errorf("Некорректная плановая дата платежа %d", index+1)
		}
		plan = append(plan, paymentInstallment{Number: index + 1, Date: date.Format("2006-01-02"), Amount: float64(cents) / 100, cents: cents})
	}
	return plan, nil
}

func buildFixedAmountPaymentPlan(totalCents int64, parts []paymentSplitAmountPart) ([]paymentInstallment, error) {
	if len(parts) < 2 || len(parts) > maxInstallments {
		return nil, fmt.Errorf("Количество платежей должно быть от 2 до %d", maxInstallments)
	}
	plan := make([]paymentInstallment, 0, len(parts))
	allocated := int64(0)
	for index, part := range parts {
		cents, err := moneyTextToCents(part.Amount.String())
		if err != nil || cents < 1 {
			return nil, fmt.Errorf("Укажите положительную сумму платежа %d с точностью до копеек", index+1)
		}
		accountType := strings.TrimSpace(part.AccountType)
		if accountType != "ОМС" && accountType != "Коммерция" {
			return nil, fmt.Errorf("Выберите признак учёта ОМС или Коммерция для платежа %d", index+1)
		}
		date := strings.TrimSpace(part.PlannedDate)
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return nil, fmt.Errorf("Некорректная плановая дата платежа %d", index+1)
		}
		if cents > totalCents-allocated {
			return nil, fmt.Errorf("Сумма платежей превышает общую сумму после платежа %d", index+1)
		}
		allocated += cents
		plan = append(plan, paymentInstallment{Number: index + 1, Date: date, Amount: float64(cents) / 100, AccountType: accountType, cents: cents})
	}
	if allocated != totalCents {
		return nil, fmt.Errorf("Сумма платежей должна совпадать с общей суммой: указано %s из %s", formatCents(allocated), formatCents(totalCents))
	}
	return plan, nil
}

func buildPercentagePaymentPlan(totalCents int64, defaultDate time.Time, parts []paymentSplitPercentagePart) ([]paymentInstallment, error) {
	if len(parts) < 2 || len(parts) > maxInstallments {
		return nil, fmt.Errorf("Количество долей должно быть от 2 до %d", maxInstallments)
	}
	basisPoints := make([]int64, len(parts))
	totalBasisPoints := int64(0)
	for index, part := range parts {
		points, err := percentageTextToBasisPoints(part.Percent.String())
		if err != nil || points <= 0 || points > 10000 {
			return nil, fmt.Errorf("Укажите корректный процент для доли %d с точностью до двух знаков", index+1)
		}
		if strings.TrimSpace(part.AccountType) == "" {
			return nil, fmt.Errorf("Выберите признак учёта для доли %d", index+1)
		}
		basisPoints[index] = points
		totalBasisPoints += points
	}
	if totalBasisPoints != 10000 {
		return nil, fmt.Errorf("Сумма долей должна быть ровно 100%%, сейчас %.2f%%", float64(totalBasisPoints)/100)
	}

	type fraction struct {
		index     int
		remainder int64
	}
	amounts := make([]int64, len(parts))
	fractions := make([]fraction, len(parts))
	allocated := int64(0)
	denominator := big.NewInt(10000)
	for index, points := range basisPoints {
		product := new(big.Int).Mul(big.NewInt(totalCents), big.NewInt(points))
		remainder := new(big.Int)
		quotient := new(big.Int)
		quotient.QuoRem(product, denominator, remainder)
		amounts[index] = quotient.Int64()
		allocated += amounts[index]
		fractions[index] = fraction{index: index, remainder: remainder.Int64()}
	}
	sort.SliceStable(fractions, func(left, right int) bool { return fractions[left].remainder > fractions[right].remainder })
	remaining := totalCents - allocated
	for offset := int64(0); offset < remaining; offset++ {
		amounts[fractions[int(offset)%len(fractions)].index]++
	}

	plan := make([]paymentInstallment, 0, len(parts))
	for index, part := range parts {
		if amounts[index] < 1 {
			return nil, fmt.Errorf("Доля %d получается меньше одной копейки", index+1)
		}
		date := strings.TrimSpace(part.PlannedDate)
		if date == "" {
			date = defaultDate.Format("2006-01-02")
		}
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return nil, fmt.Errorf("Некорректная дата для доли %d", index+1)
		}
		plan = append(plan, paymentInstallment{Number: index + 1, Date: date, Amount: float64(amounts[index]) / 100, Percent: float64(basisPoints[index]) / 100, AccountType: strings.TrimSpace(part.AccountType), cents: amounts[index], basisPoints: basisPoints[index]})
	}
	return plan, nil
}

func percentageTextToBasisPoints(value string) (int64, error) {
	points, err := moneyTextToCents(value)
	if err != nil {
		return 0, err
	}
	return points, nil
}

func moneyTextToCents(value string) (int64, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), ",", ".")
	if value == "" {
		return 0, errors.New("empty money value")
	}
	negative := strings.HasPrefix(value, "-")
	value = strings.TrimPrefix(strings.TrimPrefix(value, "+"), "-")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" {
		return 0, errors.New("invalid money value")
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = strings.TrimRight(parts[1], "0")
		if len(fraction) > 2 {
			return 0, errors.New("money has more than two decimal places")
		}
	}
	fraction += strings.Repeat("0", 2-len(fraction))
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole > (int64(^uint64(0)>>1)-99)/100 {
		return 0, errors.New("money value is out of range")
	}
	kopecks := int64(0)
	if fraction != "" {
		kopecks, err = strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			return 0, errors.New("invalid money fraction")
		}
	}
	cents := whole*100 + kopecks
	if negative {
		cents = -cents
	}
	return cents, nil
}

func formatCents(value int64) string {
	return fmt.Sprintf("%d.%02d", value/100, value%100)
}

func newSplitGroupID() (string, error) {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "split-" + hex.EncodeToString(bytes), nil
}
