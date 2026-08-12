package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultFNSBaseURL = "https://pb.nalog.ru"
	fnsResponseLimit  = 2 << 20
)

var (
	errFNSNotFound = errors.New("counterparty not found in FNS")
	errFNSCaptcha  = errors.New("FNS captcha required")
	errFNSRate     = errors.New("FNS rate limit exceeded")
	errFNSUpstream = errors.New("FNS service unavailable")
)

type fnsCounterpartyClient struct {
	baseURL string
	timeout time.Duration
	limit   chan struct{}
	once    sync.Once
}

type fnsExistingReference struct {
	ID     int64  `json:"id"`
	Value  string `json:"value"`
	TaxID  string `json:"tax_id"`
	Active bool   `json:"active"`
}

type fnsDirector struct {
	Name     string `json:"name"`
	Position string `json:"position"`
}

type fnsCounterparty struct {
	Source            string                `json:"source"`
	SourceURL         string                `json:"source_url"`
	RetrievedAt       time.Time             `json:"retrieved_at"`
	EntityType        string                `json:"entity_type"`
	TaxID             string                `json:"tax_id"`
	SuggestedName     string                `json:"suggested_name"`
	ShortName         string                `json:"short_name,omitempty"`
	FullName          string                `json:"full_name,omitempty"`
	KPP               string                `json:"kpp,omitempty"`
	OGRN              string                `json:"ogrn,omitempty"`
	RegistrationDate  string                `json:"registration_date,omitempty"`
	Status            string                `json:"status,omitempty"`
	Active            bool                  `json:"active"`
	Invalid           bool                  `json:"invalid"`
	Address           string                `json:"address,omitempty"`
	Region            string                `json:"region,omitempty"`
	OKVEDCode         string                `json:"okved_code,omitempty"`
	OKVEDName         string                `json:"okved_name,omitempty"`
	RegistryUpdatedAt string                `json:"registry_updated_at,omitempty"`
	Director          *fnsDirector          `json:"director,omitempty"`
	Warnings          []string              `json:"warnings"`
	ExistingReference *fnsExistingReference `json:"existing_reference,omitempty"`
}

type fnsSearchRow struct {
	NameShort    string          `json:"namec"`
	NameFull     string          `json:"namep"`
	TaxID        string          `json:"inn"`
	OGRN         string          `json:"ogrn"`
	OGRNDate     string          `json:"dtogrn"`
	Region       string          `json:"regionname"`
	ULStatus     json.RawMessage `json:"sulst_ex"`
	ULStatusName string          `json:"sulst_name_ex"`
	IPStatus     json.RawMessage `json:"pr_sipst"`
	Invalid      json.RawMessage `json:"invalid"`
	OKVEDCode    string          `json:"okved2main"`
	OKVEDName    string          `json:"okved2mainname"`
	Token        string          `json:"token"`
}

type fnsSearchGroup struct {
	Data []fnsSearchRow `json:"data"`
}

type fnsSearchResponse struct {
	ID              string                     `json:"id"`
	Token           string                     `json:"token"`
	CaptchaRequired bool                       `json:"captchaRequired"`
	Errors          map[string]json.RawMessage `json:"ERRORS"`
	LegalEntities   *fnsSearchGroup            `json:"ul"`
	Entrepreneurs   *fnsSearchGroup            `json:"ip"`
}

type fnsCompanyResponse struct {
	Vyp        map[string]any             `json:"vyp"`
	Liquidated bool                       `json:"liquidated"`
	Type       int                        `json:"type"`
	Errors     map[string]json.RawMessage `json:"ERRORS"`
}

func newFNSCounterpartyClient() *fnsCounterpartyClient {
	return &fnsCounterpartyClient{baseURL: defaultFNSBaseURL, timeout: 35 * time.Second, limit: make(chan struct{}, 2)}
}

func validateFNSTaxID(raw string) (string, error) {
	taxID, err := normalizeCounterpartyTaxID(raw)
	if err != nil {
		return "", err
	}
	if taxID == "" {
		return "", errors.New("Введите ИНН организации или ИП")
	}
	digits := make([]int, len(taxID))
	for index := range taxID {
		digits[index] = int(taxID[index] - '0')
	}
	checksum := func(weights []int) int {
		total := 0
		for index, weight := range weights {
			total += digits[index] * weight
		}
		return total % 11 % 10
	}
	valid := len(digits) == 10 && checksum([]int{2, 4, 10, 3, 5, 9, 4, 6, 8}) == digits[9]
	if len(digits) == 12 {
		valid = checksum([]int{7, 2, 4, 10, 3, 5, 9, 4, 6, 8}) == digits[10] &&
			checksum([]int{3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8}) == digits[11]
	}
	if !valid {
		return "", errors.New("Некорректный ИНН: проверьте контрольные цифры")
	}
	return taxID, nil
}

func (client *fnsCounterpartyClient) lookup(ctx context.Context, rawTaxID string) (fnsCounterparty, error) {
	taxID, err := validateFNSTaxID(rawTaxID)
	if err != nil {
		return fnsCounterparty{}, err
	}
	if client == nil {
		client = newFNSCounterpartyClient()
	}
	if client.timeout <= 0 {
		client.timeout = 35 * time.Second
	}
	if client.baseURL == "" {
		client.baseURL = defaultFNSBaseURL
	}
	client.once.Do(func() {
		if client.limit == nil {
			client.limit = make(chan struct{}, 2)
		}
	})
	select {
	case client.limit <- struct{}{}:
		defer func() { <-client.limit }()
	case <-ctx.Done():
		return fnsCounterparty{}, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	jar, _ := cookiejar.New(nil)
	httpClient := &http.Client{
		Timeout: client.timeout,
		Jar:     jar,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 || !sameOfficialFNSHost(request.URL.Hostname(), client.baseURL) {
				return errors.New("unexpected FNS redirect")
			}
			return nil
		},
	}
	search, err := client.search(ctx, httpClient, taxID)
	if err != nil {
		return fnsCounterparty{}, err
	}
	result := fnsCounterpartyFromSearch(taxID, search)
	if search.Token == "" {
		result.Warnings = append(result.Warnings, "ФНС не предоставила подробную карточку; показаны сведения из результата поиска")
		return result, nil
	}
	details, err := client.company(ctx, httpClient, search.Token)
	if err != nil {
		if errors.Is(err, errFNSCaptcha) || errors.Is(err, errFNSRate) {
			return fnsCounterparty{}, err
		}
		result.Warnings = append(result.Warnings, "Подробная карточка ФНС временно недоступна; показаны основные сведения")
		return result, nil
	}
	mergeFNSCompanyDetails(&result, details)
	return result, nil
}

func sameOfficialFNSHost(host, baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	return err == nil && strings.EqualFold(host, parsed.Hostname())
}

func (client *fnsCounterpartyClient) search(ctx context.Context, httpClient *http.Client, taxID string) (fnsSearchRow, error) {
	initial := url.Values{"mode": {"search-all"}, "queryAll": {taxID}, "page": {"1"}, "pageSize": {"10"}, "pbCaptchaToken": {""}}
	var request fnsSearchResponse
	if err := client.postFormJSON(ctx, httpClient, "/search-proc.json", initial, &request); err != nil {
		return fnsSearchRow{}, err
	}
	if err := classifyFNSResponse(request.CaptchaRequired, request.Errors); err != nil {
		return fnsSearchRow{}, err
	}
	if request.ID == "" {
		return fnsSearchRow{}, fmt.Errorf("%w: search request id is empty", errFNSUpstream)
	}
	var response fnsSearchResponse
	if err := client.poll(ctx, func() error {
		response = fnsSearchResponse{}
		return client.postFormJSON(ctx, httpClient, "/search-proc.json", url.Values{"id": {request.ID}, "method": {"get-response"}}, &response)
	}, func() bool {
		return response.LegalEntities != nil || response.Entrepreneurs != nil || len(response.Errors) > 0
	}); err != nil {
		return fnsSearchRow{}, err
	}
	if err := classifyFNSResponse(response.CaptchaRequired, response.Errors); err != nil {
		return fnsSearchRow{}, err
	}
	rows := []fnsSearchRow{}
	if len(taxID) == 12 && response.Entrepreneurs != nil {
		rows = response.Entrepreneurs.Data
	} else if len(taxID) == 10 && response.LegalEntities != nil {
		rows = response.LegalEntities.Data
	}
	var selected *fnsSearchRow
	for index := range rows {
		if strings.TrimSpace(rows[index].TaxID) != taxID {
			continue
		}
		if selected == nil || (!fnsSearchRowActive(*selected, len(taxID)) && fnsSearchRowActive(rows[index], len(taxID))) {
			selected = &rows[index]
		}
	}
	if selected == nil {
		return fnsSearchRow{}, errFNSNotFound
	}
	return *selected, nil
}

func (client *fnsCounterpartyClient) company(ctx context.Context, httpClient *http.Client, token string) (fnsCompanyResponse, error) {
	var request fnsSearchResponse
	if err := client.postFormJSON(ctx, httpClient, "/company-proc.json", url.Values{"token": {token}, "method": {"get-request"}}, &request); err != nil {
		return fnsCompanyResponse{}, err
	}
	if err := classifyFNSResponse(request.CaptchaRequired, request.Errors); err != nil {
		return fnsCompanyResponse{}, err
	}
	if request.ID == "" || request.Token == "" {
		return fnsCompanyResponse{}, fmt.Errorf("%w: company request is incomplete", errFNSUpstream)
	}
	var response fnsCompanyResponse
	err := client.poll(ctx, func() error {
		response = fnsCompanyResponse{}
		return client.postFormJSON(ctx, httpClient, "/company-proc.json", url.Values{"token": {request.Token}, "id": {request.ID}, "method": {"get-response"}}, &response)
	}, func() bool { return len(response.Vyp) > 0 || len(response.Errors) > 0 })
	if err != nil {
		return fnsCompanyResponse{}, err
	}
	if err := classifyFNSResponse(false, response.Errors); err != nil {
		return fnsCompanyResponse{}, err
	}
	if len(response.Vyp) == 0 {
		return fnsCompanyResponse{}, fmt.Errorf("%w: company card is empty", errFNSUpstream)
	}
	return response, nil
}

func (client *fnsCounterpartyClient) poll(ctx context.Context, load func() error, ready func() bool) error {
	for attempt := 0; attempt < 12; attempt++ {
		if err := load(); err != nil {
			return err
		}
		if ready() {
			return nil
		}
		delay := 250 * time.Millisecond
		if attempt > 3 {
			delay = 600 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return fmt.Errorf("%w: response timeout", errFNSUpstream)
}

func (client *fnsCounterpartyClient) postFormJSON(ctx context.Context, httpClient *http.Client, path string, values url.Values, output any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(client.baseURL, "/")+path, strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json, text/javascript, */*; q=0.01")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	request.Header.Set("Referer", strings.TrimRight(client.baseURL, "/")+"/")
	request.Header.Set("User-Agent", "ObligationsRegistry/1.0 (counterparty lookup via FNS Transparent Business)")
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	response, err := httpClient.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("%w: timeout", errFNSUpstream)
		}
		return fmt.Errorf("%w: %v", errFNSUpstream, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, fnsResponseLimit+1))
	if err != nil || len(body) > fnsResponseLimit {
		return fmt.Errorf("%w: invalid response", errFNSUpstream)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var fnsError struct {
			Errors map[string]json.RawMessage `json:"ERRORS"`
		}
		_ = json.Unmarshal(body, &fnsError)
		if classified := classifyFNSResponse(false, fnsError.Errors); classified != nil {
			return classified
		}
		return fmt.Errorf("%w: HTTP %d", errFNSUpstream, response.StatusCode)
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if err := json.Unmarshal(body, output); err != nil {
		return fmt.Errorf("%w: invalid JSON", errFNSUpstream)
	}
	return nil
}

func classifyFNSResponse(captchaRequired bool, responseErrors map[string]json.RawMessage) error {
	if captchaRequired {
		return errFNSCaptcha
	}
	for key := range responseErrors {
		switch strings.ToLower(key) {
		case "pbsearchcaptcha", "pbcaptcha":
			return errFNSCaptcha
		case "pbratelimit":
			return errFNSRate
		}
	}
	if len(responseErrors) > 0 {
		return errFNSUpstream
	}
	return nil
}

func fnsCounterpartyFromSearch(taxID string, row fnsSearchRow) fnsCounterparty {
	entityType := "legal_entity"
	if len(taxID) == 12 {
		entityType = "individual_entrepreneur"
	}
	shortName := strings.TrimSpace(row.NameShort)
	fullName := strings.TrimSpace(row.NameFull)
	suggestedName := shortName
	if suggestedName == "" {
		suggestedName = fullName
	}
	if entityType == "individual_entrepreneur" && suggestedName != "" && !strings.HasPrefix(strings.ToUpper(suggestedName), "ИП ") {
		suggestedName = "ИП " + suggestedName
	}
	status := strings.TrimSpace(row.ULStatusName)
	active := fnsSearchRowActive(row, len(taxID))
	if status == "" {
		if active {
			status = "Действующий"
		} else {
			status = "Деятельность прекращена"
		}
	}
	return fnsCounterparty{
		Source:           "ФНС России — Прозрачный бизнес",
		SourceURL:        defaultFNSBaseURL + "/search.html#mode=search-all&queryAll=" + url.QueryEscape(taxID),
		RetrievedAt:      time.Now().UTC(),
		EntityType:       entityType,
		TaxID:            taxID,
		SuggestedName:    suggestedName,
		ShortName:        shortName,
		FullName:         fullName,
		OGRN:             strings.TrimSpace(row.OGRN),
		RegistrationDate: normalizeFNSDate(row.OGRNDate),
		Status:           status,
		Active:           active,
		Invalid:          rawJSONBool(row.Invalid),
		Region:           strings.TrimSpace(row.Region),
		OKVEDCode:        strings.TrimSpace(row.OKVEDCode),
		OKVEDName:        strings.TrimSpace(row.OKVEDName),
		Warnings:         []string{},
	}
}

func fnsSearchRowActive(row fnsSearchRow, taxIDLength int) bool {
	if taxIDLength == 12 {
		return rawJSONString(row.IPStatus) == "0"
	}
	return rawJSONString(row.ULStatus) == "10"
}

func mergeFNSCompanyDetails(result *fnsCounterparty, details fnsCompanyResponse) {
	if result == nil {
		return
	}
	vyp := details.Vyp
	fillString(&result.ShortName, mapString(vyp, "НаимЮЛСокр", "НаимИПСокр"))
	fillString(&result.FullName, mapString(vyp, "НаимЮЛПолн", "НаимИППолн", "ФИО"))
	fillString(&result.KPP, mapString(vyp, "КПП"))
	fillString(&result.OGRN, mapString(vyp, "ОГРН", "ОГРНИП"))
	fillString(&result.Address, mapString(vyp, "АдресРФ", "Адрес"))
	fillString(&result.Region, mapString(vyp, "НаимРегион"))
	fillString(&result.OKVEDCode, mapString(vyp, "КодОКВЭД"))
	fillString(&result.OKVEDName, mapString(vyp, "НаимОКВЭД"))
	fillString(&result.RegistryUpdatedAt, normalizeFNSDate(mapString(vyp, "ДатаВып", "ДатаЗаписи")))
	if registrationDate := normalizeFNSDate(mapString(vyp, "ДатаРег", "ДатаОГРН", "ДатаОГРНИП")); registrationDate != "" {
		result.RegistrationDate = registrationDate
	}
	if status := mapString(vyp, "sulst_name_ex", "НаимСтатус"); status != "" {
		result.Status = status
	}
	if shortName := strings.TrimSpace(result.ShortName); shortName != "" {
		result.SuggestedName = shortName
	} else if fullName := strings.TrimSpace(result.FullName); fullName != "" {
		result.SuggestedName = fullName
	}
	if result.EntityType == "individual_entrepreneur" && result.SuggestedName != "" && !strings.HasPrefix(strings.ToUpper(result.SuggestedName), "ИП ") {
		result.SuggestedName = "ИП " + result.SuggestedName
	}
	result.Invalid = result.Invalid || mapBool(vyp, "invalid")
	if details.Liquidated {
		result.Active = false
	}
	if directors, ok := vyp["masruk"].([]any); ok && len(directors) > 0 {
		if director, ok := directors[0].(map[string]any); ok {
			name := mapString(director, "name")
			position := mapString(director, "position")
			if name != "" || position != "" {
				result.Director = &fnsDirector{Name: name, Position: position}
			}
		}
	}
	if !result.Active || result.Invalid {
		result.Warnings = append(result.Warnings, "Контрагент имеет недействующий или прекращённый статус в ФНС")
	}
}

func mapString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := values[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return strings.TrimSpace(typed)
			}
		case json.Number:
			return string(typed)
		case float64:
			return strconv.FormatFloat(typed, 'f', -1, 64)
		}
	}
	return ""
}

func mapBool(values map[string]any, key string) bool {
	value, ok := values[key]
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case float64:
		return typed != 0
	case string:
		return typed == "1" || strings.EqualFold(typed, "true")
	default:
		return false
	}
}

func rawJSONString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	var number json.Number
	if json.Unmarshal(raw, &number) == nil {
		return string(number)
	}
	return ""
}

func rawJSONBool(raw json.RawMessage) bool {
	value := rawJSONString(raw)
	return value == "1" || strings.EqualFold(value, "true")
}

func fillString(target *string, value string) {
	if target != nil && strings.TrimSpace(value) != "" {
		*target = strings.TrimSpace(value)
	}
}

func normalizeFNSDate(value string) string {
	value = strings.TrimSpace(value)
	for _, layout := range []string{"2006-01-02", "02.01.2006", "02/01/2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.Format("2006-01-02")
		}
	}
	return value
}

func (a *app) lookupNewCounterpartyFNS(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TaxID string `json:"tax_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	result, err := a.fnsClient().lookup(r.Context(), input.TaxID)
	if err != nil {
		writeFNSError(w, err)
		return
	}
	existing, err := a.findCounterpartyConflict(r.Context(), result.TaxID, result.SuggestedName)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось проверить дублирование контрагента")
		return
	}
	result.ExistingReference = existing
	writeJSON(w, http.StatusOK, result)
}

func (a *app) counterpartyFNSDetails(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		fail(w, http.StatusBadRequest, "Некорректный контрагент")
		return
	}
	var value string
	var taxID sql.NullString
	if err = a.db.QueryRowContext(r.Context(), `SELECT value,tax_id FROM reference_values WHERE id=$1 AND kind=$2 AND active`, id, counterpartyReferenceKind).Scan(&value, &taxID); err == sql.ErrNoRows {
		fail(w, http.StatusNotFound, "Контрагент не найден")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "Не удалось загрузить контрагента")
		return
	}
	if strings.TrimSpace(taxID.String) == "" {
		fail(w, http.StatusUnprocessableEntity, "Для этого контрагента ИНН не указан. Карточка ФНС недоступна")
		return
	}
	result, err := a.fnsClient().lookup(r.Context(), taxID.String)
	if err != nil {
		writeFNSError(w, err)
		return
	}
	result.ExistingReference = &fnsExistingReference{ID: id, Value: value, TaxID: taxID.String, Active: true}
	writeJSON(w, http.StatusOK, result)
}

func (a *app) fnsClient() *fnsCounterpartyClient {
	if a.fns == nil {
		a.fns = newFNSCounterpartyClient()
	}
	return a.fns
}

func (a *app) findCounterpartyConflict(ctx context.Context, taxID, suggestedName string) (*fnsExistingReference, error) {
	var result fnsExistingReference
	if err := a.db.QueryRowContext(ctx, `
		SELECT id,value,COALESCE(tax_id,''),active
		FROM reference_values
		WHERE kind=$1 AND (tax_id=$2 OR lower(value)=lower($3))
		ORDER BY (tax_id=$2) DESC,active DESC,id
		LIMIT 1`, counterpartyReferenceKind, taxID, strings.TrimSpace(suggestedName)).Scan(&result.ID, &result.Value, &result.TaxID, &result.Active); err == sql.ErrNoRows {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	return &result, nil
}

func writeFNSError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFNSNotFound):
		fail(w, http.StatusNotFound, "Контрагент с таким ИНН не найден в ЕГРЮЛ/ЕГРИП ФНС")
	case errors.Is(err, errFNSCaptcha):
		fail(w, http.StatusServiceUnavailable, "ФНС временно требует дополнительную проверку. Повторите запрос позднее или добавьте контрагента вручную")
	case errors.Is(err, errFNSRate):
		fail(w, http.StatusTooManyRequests, "Превышен лимит запросов ФНС. Повторите попытку позднее")
	case errors.Is(err, errFNSUpstream), errors.Is(err, context.DeadlineExceeded):
		fail(w, http.StatusBadGateway, "Сервис ФНС временно недоступен. Данные справочника не изменены")
	default:
		fail(w, http.StatusBadRequest, err.Error())
	}
}
