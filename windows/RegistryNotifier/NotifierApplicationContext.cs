using System.Collections.Concurrent;
using System.Diagnostics;

namespace Mirt.RegistryNotifier;

internal sealed class NotifierApplicationContext : ApplicationContext
{
    private readonly SettingsStore _store = new();
    private readonly ApiClient _api = new();
    private readonly AppSettings _settings;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _historyItem;
    private readonly ToolStripMenuItem _pauseItem;
    private readonly ToolStripMenuItem _autostartItem;
    private readonly ToolStripMenuItem _updateItem;
    private readonly AutoUpdater _autoUpdater;
    private readonly System.Windows.Forms.Timer _updateTimer;
    private readonly ConcurrentQueue<DesktopNotification> _notifications = new();
    private readonly object _historySync = new();
    private readonly List<DesktopNotification> _history;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Control _dispatcher = new();
    private NotificationPopup? _popup;
    private NotificationCenterForm? _historyForm;
    private string _token;
    private bool _checking;
    private bool _loginOpen;
    private bool _updateChecking;
    private DesktopAppUpdate? _availableUpdate;
    private UpdateAvailableForm? _updateForm;
    private string _shownUpdateVersion = "";
    private string _connectionStatus = "Подключение…";
    private DateTimeOffset? _lastSuccessfulSync;
    private int _pollGeneration;

    public NotifierApplicationContext(string? afterUpdateVersion = null)
    {
        _dispatcher.CreateControl();
        _settings = _store.Load();
        _token = _store.ReadToken(_settings);
        _history = _store.LoadNotificationHistory(_settings.Email).ToList();
        _autoUpdater = new AutoUpdater(_api, _store);
        try { ContextMenuManager.Install(); }
        catch (Exception error) { _store.Log("Не удалось обновить контекстное меню: " + error.Message); }
        _statusItem = new ToolStripMenuItem("Подключение…") { Enabled = false };
        _historyItem = new ToolStripMenuItem(HistoryMenuText());
        _pauseItem = new ToolStripMenuItem(_settings.Paused ? "Возобновить уведомления" : "Приостановить уведомления");
        _autostartItem = new ToolStripMenuItem("Запускать вместе с Windows") { CheckOnClick = true, Checked = AutostartManager.IsEnabled() };
        _updateItem = new ToolStripMenuItem($"Проверить обновления · {AutoUpdater.CurrentVersion.ToString(3)}");
        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Открыть реестр", null, (_, _) => OpenRegistry(""));
        menu.Items.Add(_historyItem);
        menu.Items.Add("Проверить сейчас", null, async (_, _) => await CheckNowAsync());
        menu.Items.Add(_updateItem);
        menu.Items.Add(_pauseItem);
        menu.Items.Add(_autostartItem);
        menu.Items.Add("Сменить пользователя / сервер", null, (_, _) => ShowLogin());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Выход", null, (_, _) => Exit());
        _pauseItem.Click += (_, _) => TogglePause();
        _historyItem.Click += (_, _) => ShowNotificationCenter();
        _updateItem.Click += async (_, _) => await CheckForUpdateAsync(true);
        _autostartItem.CheckedChanged += (_, _) => SetAutostart(_autostartItem.Checked);
        _tray = new NotifyIcon { Icon = AppIcon.Create(), Text = "Уведомления реестра", ContextMenuStrip = menu, Visible = true };
        _tray.DoubleClick += (_, _) => OpenRegistry("");
        _updateTimer = new System.Windows.Forms.Timer { Interval = 6 * 60 * 60 * 1000 };
        _updateTimer.Tick += async (_, _) => await CheckForUpdateAsync(false);
        _updateTimer.Start();

        if (_settings.Autostart && !AutostartManager.IsEnabled()) SetAutostart(true);
        if (string.IsNullOrEmpty(_token)) Ui(ShowLogin);
        else { StartPolling(); _ = CheckForUpdateAsync(false); }
        if (!string.IsNullOrWhiteSpace(afterUpdateVersion)) ShowBalloon("ФинРеестр обновлён", $"Установлена версия {afterUpdateVersion}.", ToolTipIcon.Info);
    }

    private void StartPolling() => _ = PollLoopAsync(Interlocked.Increment(ref _pollGeneration), _shutdown.Token);

    private void ShowLogin()
    {
        if (_loginOpen) return;
        _loginOpen = true;
        var previousEmail = _settings.Email;
        using var form = new LoginForm(_api, _settings);
        try
        {
            if (form.ShowDialog() != DialogResult.OK || form.Result == null) return;
            var userChanged = !string.Equals(previousEmail, form.Result.User.Email, StringComparison.OrdinalIgnoreCase);
            _token = form.Result.Token;
            _store.SetToken(_settings, _token);
            _settings.Cursor = 0;
            _settings.CursorInitialized = false;
            _settings.Paused = false;
            _store.Save(_settings);
            if (userChanged)
            {
                while (_notifications.TryDequeue(out _)) { }
                _popup?.Close();
                _lastSuccessfulSync = null;
                lock (_historySync)
                {
                    _history.Clear();
                    _history.AddRange(_store.LoadNotificationHistory(_settings.Email));
                }
                RefreshNotificationCenter();
            }
            _statusItem.Text = $"Подключено: {form.Result.User.Name}";
            _pauseItem.Text = "Приостановить уведомления";
            StartPolling();
            _ = CheckForUpdateAsync(false);
        }
        finally { _loginOpen = false; }
    }

    private async Task PollLoopAsync(int generation, CancellationToken cancellationToken)
    {
        var consecutiveFailures = 0;
        while (!cancellationToken.IsCancellationRequested && generation == _pollGeneration && !string.IsNullOrEmpty(_token))
        {
            if (_settings.Paused)
            {
                SetStatus("Уведомления приостановлены");
                try { await Task.Delay(1500, cancellationToken); } catch (OperationCanceledException) { }
                continue;
            }
            try
            {
                var response = await _api.PollAsync(_settings.ServerUrl, _token, _settings.Cursor, 20, !_settings.CursorInitialized, cancellationToken);
                if (generation != _pollGeneration) return;
                consecutiveFailures = 0;
                _lastSuccessfulSync = response.ServerTime;
                SetStatus("Подключено · ожидание сообщений");
                RememberNotifications(response.Items);
                foreach (var item in response.Items.OrderBy(item => item.Id)) _notifications.Enqueue(item);
                if (response.NextCursor > _settings.Cursor)
                {
                    _settings.Cursor = response.NextCursor;
                }
                _settings.CursorInitialized = true;
                _store.Save(_settings);
                ShowNextNotification();
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (ApiException error) when (error.StatusCode == 401)
            {
                _token = "";
                _settings.ProtectedToken = "";
                _store.Save(_settings);
                SetStatus("Требуется повторный вход");
                ShowBalloon("Требуется вход", "Откройте значок реестра в трее и войдите снова.", ToolTipIcon.Warning);
                Ui(ShowLogin);
            }
            catch (Exception error)
            {
                _store.Log(error.ToString());
                consecutiveFailures++;
                var retryDelay = CalculateRetryDelay(consecutiveFailures);
                SetStatus($"Нет связи · повтор через {(int)retryDelay.TotalSeconds} с");
                try { await Task.Delay(retryDelay, cancellationToken); } catch (OperationCanceledException) { }
            }
        }
    }

    private async Task CheckNowAsync()
    {
        if (_checking || string.IsNullOrEmpty(_token)) return;
        _checking = true;
        try
        {
            var response = await _api.PollAsync(_settings.ServerUrl, _token, _settings.Cursor, 0, !_settings.CursorInitialized, _shutdown.Token);
            _lastSuccessfulSync = response.ServerTime;
            SetStatus("Подключено · проверено вручную");
            RememberNotifications(response.Items);
            foreach (var item in response.Items.OrderBy(item => item.Id)) _notifications.Enqueue(item);
            _settings.Cursor = Math.Max(_settings.Cursor, response.NextCursor);
            _settings.CursorInitialized = true;
            _store.Save(_settings);
            ShowNextNotification();
            ShowBalloon("Реестр обязательств", response.Items.Count == 0 ? "Новых уведомлений нет." : $"Новых уведомлений: {response.Items.Count}.", ToolTipIcon.Info);
        }
        catch (Exception error) { ShowBalloon("Не удалось проверить", error.Message, ToolTipIcon.Warning); }
        finally { _checking = false; }
    }

    private async Task CheckForUpdateAsync(bool announceWhenCurrent)
    {
        if (_updateChecking || string.IsNullOrEmpty(_token)) return;
        if (_availableUpdate != null) { ShowUpdate(_availableUpdate); return; }
        _updateChecking = true;
        Ui(() => { _updateItem.Enabled = false; _updateItem.Text = "Проверяем обновления…"; });
        try
        {
            var update = await _autoUpdater.CheckAsync(_settings.ServerUrl, _token, _shutdown.Token);
            _availableUpdate = update;
            if (update == null)
            {
                Ui(() => { _updateItem.Text = $"Установлена актуальная версия {AutoUpdater.CurrentVersion.ToString(3)}"; _updateItem.Enabled = true; });
                if (announceWhenCurrent) ShowBalloon("Обновление ФинРеестра", "Установлена актуальная версия приложения.", ToolTipIcon.Info);
            }
            else
            {
                Ui(() => { _updateItem.Text = $"Доступно обновление {update.Version}"; _updateItem.Enabled = true; });
                ShowUpdate(update);
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
        catch (ApiException error) when (error.StatusCode == 401) { }
        catch (Exception error)
        {
            _store.Log("Update check failed: " + error);
            Ui(() => { _updateItem.Text = "Не удалось проверить обновления"; _updateItem.Enabled = true; });
            if (announceWhenCurrent) ShowBalloon("Обновление ФинРеестра", error.Message, ToolTipIcon.Warning);
        }
        finally { _updateChecking = false; }
    }

    private void ShowUpdate(DesktopAppUpdate update)
    {
        Ui(() =>
        {
            if (_updateForm is { IsDisposed: false }) { _updateForm.Activate(); return; }
            if (_shownUpdateVersion != update.Version)
            {
                ShowBalloon("Доступно обновление", $"Версия {update.Version}. Нажмите «Обновить» в окне приложения.", ToolTipIcon.Info);
                _shownUpdateVersion = update.Version;
            }
            _updateForm = new UpdateAvailableForm(update);
            _updateForm.UpdateRequested += async () => await ApplyUpdateAsync(update);
            _updateForm.FormClosed += (_, _) => _updateForm = null;
            _updateForm.Show();
            _updateForm.Activate();
        });
    }

    private async Task ApplyUpdateAsync(DesktopAppUpdate update)
    {
        try
        {
            var progress = new Progress<int>(value => _updateForm?.ReportProgress(value));
            await _autoUpdater.PrepareAndLaunchAsync(update, progress, _shutdown.Token);
            Exit();
        }
        catch (Exception error)
        {
            _store.Log("Automatic update failed: " + error);
            Ui(() => _updateForm?.ShowError(error.Message));
        }
    }

    private void ShowNextNotification()
    {
        if (_popup is { IsDisposed: false } || !_notifications.TryDequeue(out var notification)) return;
        Ui(() =>
        {
            _popup = new NotificationPopup(notification, () => OpenRegistry(notification.ActionUrl));
            _popup.FormClosed += (_, _) => { _popup = null; ShowNextNotification(); };
            _popup.Show();
        });
    }

    private void RememberNotifications(IEnumerable<DesktopNotification> items)
    {
        var incoming = items.Where(item => item.Id > 0).ToList();
        if (incoming.Count == 0) { RefreshNotificationCenter(); return; }
        List<DesktopNotification> snapshot;
        lock (_historySync)
        {
            _history.AddRange(incoming);
            snapshot = SettingsStore.NormalizeNotificationHistory(_history);
            _history.Clear();
            _history.AddRange(snapshot);
            _store.SaveNotificationHistory(_settings.Email, snapshot);
        }
        RefreshNotificationCenter();
    }

    private IReadOnlyList<DesktopNotification> NotificationHistorySnapshot()
    {
        lock (_historySync) return _history.ToList();
    }

    private string HistoryMenuText()
    {
        lock (_historySync) return _history.Count == 0 ? "Центр уведомлений" : $"Центр уведомлений · {_history.Count}";
    }

    private void ShowNotificationCenter()
    {
        if (_historyForm is { IsDisposed: false })
        {
            _historyForm.UpdateState(NotificationHistorySnapshot(), _connectionStatus, _lastSuccessfulSync);
            _historyForm.Activate();
            return;
        }
        _historyForm = new NotificationCenterForm(NotificationHistorySnapshot(), _connectionStatus, _lastSuccessfulSync, OpenRegistry, ClearNotificationHistory);
        _historyForm.FormClosed += (_, _) => _historyForm = null;
        _historyForm.Show();
        _historyForm.Activate();
    }

    private void ClearNotificationHistory()
    {
        lock (_historySync) _history.Clear();
        _store.ClearNotificationHistory(_settings.Email);
        RefreshNotificationCenter();
    }

    private void RefreshNotificationCenter() => Ui(() =>
    {
        _historyItem.Text = HistoryMenuText();
        if (_historyForm is { IsDisposed: false }) _historyForm.UpdateState(NotificationHistorySnapshot(), _connectionStatus, _lastSuccessfulSync);
    });

    private void TogglePause()
    {
        _settings.Paused = !_settings.Paused;
        _pauseItem.Text = _settings.Paused ? "Возобновить уведомления" : "Приостановить уведомления";
        _store.Save(_settings);
        if (!_settings.Paused && !string.IsNullOrEmpty(_token)) _ = CheckNowAsync();
    }

    private void SetAutostart(bool enabled)
    {
        try
        {
            AutostartManager.Set(enabled);
            _settings.Autostart = enabled;
            _store.Save(_settings);
        }
        catch (Exception error)
        {
            _autostartItem.Checked = AutostartManager.IsEnabled();
            ShowBalloon("Автозапуск", error.Message, ToolTipIcon.Warning);
        }
    }

    internal static TimeSpan CalculateRetryDelay(int consecutiveFailures)
    {
        var exponent = Math.Clamp(consecutiveFailures - 1, 0, 4);
        return TimeSpan.FromSeconds(Math.Min(60, 5 * (1 << exponent)));
    }

    private void SetStatus(string text)
    {
        _connectionStatus = text;
        Ui(() =>
        {
            _statusItem.Text = text;
            if (_historyForm is { IsDisposed: false }) _historyForm.UpdateState(NotificationHistorySnapshot(), _connectionStatus, _lastSuccessfulSync);
        });
    }
    private void ShowBalloon(string title, string text, ToolTipIcon icon) => Ui(() => _tray.ShowBalloonTip(5000, title, text, icon));
    private void Ui(Action action)
    {
        if (_shutdown.IsCancellationRequested || _dispatcher.IsDisposed) return;
        if (_dispatcher.InvokeRequired) _dispatcher.BeginInvoke(action); else action();
    }

    private void OpenRegistry(string actionUrl)
    {
        try
        {
            var uri = ApiClient.ResolveActionUrl(_settings.ServerUrl, actionUrl);
            if (uri == null) throw new ApiException("Ссылка уведомления отклонена как небезопасная.");
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception error) { ShowBalloon("Не удалось открыть реестр", error.Message, ToolTipIcon.Warning); }
    }

    private void Exit()
    {
        _shutdown.Cancel();
        _updateTimer.Stop();
        _updateTimer.Dispose();
        _updateForm?.Close();
        _historyForm?.Close();
        _popup?.Close();
        _tray.Visible = false;
        _tray.Dispose();
        _dispatcher.Dispose();
        _api.Dispose();
        _shutdown.Dispose();
        ExitThread();
    }
}
