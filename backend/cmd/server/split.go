package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxInstallments = 60

type paymentSplitInput struct {
	Mode          string       `json:"mode"`
	Count         int          `json:"count"`
	PaymentAmount *json.Number `json:"payment_amount"`
	StartDate     string       `json:"start_date"`
	PeriodUnit    string       `json:"period_unit"`
	PeriodValue   int          `json:"period_value"`
}

type paymentInstallment struct {
	Number int     `json:"number"`
	Date   string  `json:"date"`
	Amount float64 `json:"amount"`
	cents  int64
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

	var amountText, plannedDate, status, actualDate, existingGroup string
	var existingCount int
	err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(amount::text,''),COALESCE(to_char(planned_payment_date,'YYYY-MM-DD'),''),COALESCE(status,''),COALESCE(to_char(actual_payment_date,'YYYY-MM-DD'),''),COALESCE(split_group_id,''),COALESCE(installment_count,0) FROM obligations WHERE id=$1 FOR UPDATE`, id).Scan(&amountText, &plannedDate, &status, &actualDate, &existingGroup, &existingCount)
	if err != nil {
		fail(w, 404, "Платёж не найден")
		return
	}
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

	groupID, err := newSplitGroupID()
	if err != nil {
		fail(w, 500, "Не удалось создать идентификатор графика")
		return
	}
	user := currentUser(r)
	first := plan[0]
	_, err = tx.ExecContext(r.Context(), `UPDATE obligations SET amount=$1::numeric,planned_payment_date=$2::date,split_group_id=$3,split_parent_id=NULL,installment_number=1,installment_count=$4,updated_by=$5,updated_at=now() WHERE id=$6`, formatCents(first.cents), first.Date, groupID, len(plan), user.ID, id)
	if err != nil {
		fail(w, 500, "Не удалось сохранить первый платёж")
		return
	}

	createdIDs := []int64{}
	for _, installment := range plan[1:] {
		var childID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO obligations(source_row,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,amount,planned_payment_date,approval_date,actual_payment_date,status,urgency,comment,source_note,created_by,updated_by,split_group_id,split_parent_id,installment_number,installment_count)
			SELECT NULL,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,$1::numeric,$2::date,approval_date,NULL,status,urgency,comment,source_note,$3,$3,$4,$5,$6,$7
			FROM obligations WHERE id=$8 RETURNING id`, formatCents(installment.cents), installment.Date, user.ID, groupID, id, installment.Number, len(plan), id).Scan(&childID)
		if err != nil {
			fail(w, 500, "Не удалось создать часть платежа")
			return
		}
		createdIDs = append(createdIDs, childID)
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
	if input.PeriodValue == 0 {
		input.PeriodValue = 1
	}
	if input.PeriodValue < 1 || input.PeriodValue > 365 {
		return nil, errors.New("Период должен быть от 1 до 365")
	}
	switch input.PeriodUnit {
	case "month", "week", "day":
	default:
		return nil, errors.New("Выберите периодичность платежей")
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
	case "amount":
		if input.PaymentAmount == nil {
			return nil, errors.New("Укажите сумму одного платежа")
		}
		paymentCents, err := moneyTextToCents(input.PaymentAmount.String())
		if err != nil {
			return nil, errors.New("Укажите сумму одного платежа с точностью до копеек")
		}
		if paymentCents < 1 || paymentCents >= totalCents {
			return nil, errors.New("Сумма части должна быть больше нуля и меньше общей суммы")
		}
		count := int((totalCents + paymentCents - 1) / paymentCents)
		if count > maxInstallments {
			return nil, fmt.Errorf("Получается больше %d платежей — увеличьте сумму части", maxInstallments)
		}
		remaining := totalCents
		for remaining > 0 {
			part := paymentCents
			if remaining < part {
				part = remaining
			}
			amounts = append(amounts, part)
			remaining -= part
		}
	default:
		return nil, errors.New("Выберите способ разбиения")
	}

	plan := make([]paymentInstallment, 0, len(amounts))
	for index, cents := range amounts {
		date := installmentDate(startDate, index, input.PeriodUnit, input.PeriodValue)
		plan = append(plan, paymentInstallment{Number: index + 1, Date: date.Format("2006-01-02"), Amount: float64(cents) / 100, cents: cents})
	}
	return plan, nil
}

func installmentDate(start time.Time, index int, unit string, period int) time.Time {
	switch unit {
	case "month":
		return addMonthsClamped(start, index*period)
	case "week":
		return start.AddDate(0, 0, index*period*7)
	default:
		return start.AddDate(0, 0, index*period)
	}
}

func addMonthsClamped(value time.Time, months int) time.Time {
	monthStart := time.Date(value.Year(), value.Month()+time.Month(months), 1, 0, 0, 0, 0, value.Location())
	lastDay := time.Date(monthStart.Year(), monthStart.Month()+1, 0, 0, 0, 0, 0, value.Location()).Day()
	day := value.Day()
	if day > lastDay {
		day = lastDay
	}
	return time.Date(monthStart.Year(), monthStart.Month(), day, 0, 0, 0, 0, value.Location())
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
