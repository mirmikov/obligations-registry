package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type seedPayload struct {
	Records    []obligationInput   `json:"records"`
	References map[string][]string `json:"references"`
}

func (a *app) migrateAndSeed(ctx context.Context) error {
	migration, err := assets.ReadFile("migrations.sql")
	if err != nil {
		return err
	}
	if _, err = a.db.ExecContext(ctx, string(migration)); err != nil {
		return fmt.Errorf("migration: %w", err)
	}
	if err = a.seedUsers(ctx); err != nil {
		return err
	}
	var count int
	if err = a.db.QueryRowContext(ctx, "SELECT count(*) FROM obligations").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	data, err := assets.ReadFile("seed/registry.json")
	if err != nil {
		return err
	}
	var seed seedPayload
	if err = json.Unmarshal(data, &seed); err != nil {
		return err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for kind, values := range seed.References {
		kind = normalizeReferenceKind(kind)
		if kind == "" {
			continue
		}
		for index, value := range values {
			_, err = tx.ExecContext(ctx, `INSERT INTO reference_values(kind,value,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, kind, strings.TrimSpace(value), index)
			if err != nil {
				return err
			}
		}
	}
	for _, item := range seed.Records {
		if _, err = insertObligation(ctx, tx, item, nil); err != nil {
			return fmt.Errorf("seed row %d: %w", item.SourceRow, err)
		}
	}
	return tx.Commit()
}

func (a *app) seedUsers(ctx context.Context) error {
	users := []struct{ name, email, password, role string }{
		{"Администратор", getenv("ADMIN_EMAIL", "admin"), getenv("ADMIN_PASSWORD", "Qazxsw21"), "admin"},
	}
	for _, user := range users {
		hash, err := bcrypt.GenerateFromPassword([]byte(user.password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		_, err = a.db.ExecContext(ctx, `INSERT INTO users(name,email,password_hash,role) VALUES($1,lower($2),$3,$4) ON CONFLICT(email) DO NOTHING`, user.name, user.email, string(hash), user.role)
		if err != nil {
			return err
		}
	}
	return nil
}

type dbExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func insertObligation(ctx context.Context, db dbExecer, input obligationInput, userID *int64) (int64, error) {
	if err := applyCounterpartyDefermentDefault(ctx, db, &input); err != nil {
		return 0, err
	}
	input.normalize()
	var id int64
	err := db.QueryRowContext(ctx, `
		INSERT INTO obligations(source_row,account_type,entry_date,counterparty,legal_entity,cost_category,priority,responsible,document_number,deferment_days,document_date,amount,planned_payment_date,approval_date,actual_payment_date,status,urgency,comment,source_note,created_by,updated_by)
		VALUES($1,$2,NULLIF($3,'')::date,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,'')::date,$12,NULLIF($13,'')::date,NULLIF($14,'')::date,NULLIF($15,'')::date,$16,$17,$18,$19,$20,$20)
		RETURNING id`, input.SourceRow, nullable(input.AccountType), nullable(input.EntryDate), nullable(input.Counterparty), nullable(input.LegalEntity), nullable(input.CostCategory), nullable(input.Priority), nullable(input.Responsible), nullable(input.DocumentNumber), input.DefermentDays, nullable(input.DocumentDate), input.Amount, nullable(input.PlannedPaymentDate), nullable(input.ApprovalDate), nullable(input.ActualPaymentDate), nullable(input.Status), nullable(input.Urgency), nullable(input.Comment), nullable(input.SourceNote), userID).Scan(&id)
	return id, err
}

func nullable(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func (input *obligationInput) normalize() {
	if input.EntryDate == "" {
		input.EntryDate = time.Now().Format("2006-01-02")
	}
	input.Status = automaticObligationStatus(input.ApprovalDate, input.ActualPaymentDate, input.Status)
	if input.DocumentDate != "" && input.DefermentDays != nil {
		if date, err := time.Parse("2006-01-02", input.DocumentDate); err == nil {
			input.PlannedPaymentDate = date.AddDate(0, 0, *input.DefermentDays).Format("2006-01-02")
		}
	}
}

func (input *obligationInput) normalizeForUpdate(previousApprovalDate string) {
	requestedStatus := input.Status
	input.normalize()
	if strings.TrimSpace(input.ActualPaymentDate) == "" && strings.TrimSpace(input.ApprovalDate) == strings.TrimSpace(previousApprovalDate) {
		input.Status = requestedStatus
	}
}

func automaticObligationStatus(approvalDate, actualPaymentDate, status string) string {
	if strings.TrimSpace(actualPaymentDate) != "" {
		return "Оплачено"
	}
	if strings.TrimSpace(approvalDate) != "" {
		return "К оплате"
	}
	return status
}

func automaticPaymentStatus(actualPaymentDate, status string) string {
	return automaticObligationStatus("", actualPaymentDate, status)
}

func normalizeReferenceKind(kind string) string {
	switch kind {
	case "statuses", "cost_categories", "priorities", "urgencies", "legal_entities", "responsibles", "account_types", "counterparties":
		return kind
	default:
		return ""
	}
}

func (a *app) audit(ctx context.Context, userID int64, action, entityType string, entityID *int64, details any) {
	data, _ := json.Marshal(details)
	_, _ = a.db.ExecContext(ctx, `INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)`, userID, action, entityType, entityID, data)
}
