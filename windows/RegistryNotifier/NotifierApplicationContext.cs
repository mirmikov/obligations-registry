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
    private readonly ToolStripMenuItem _pauseItem;
    private readonly ToolStripMenuItem _autostartItem;
    private readonly ConcurrentQueue<DesktopNotification> _notifications = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Control _dispatcher = new();
    private NotificationPopup? _popup;
    private string _token;
    private bool _checking;
    private bool _loginOpen;
    private int _pollGeneration;

    public NotifierApplicationContext()
    {
		_dispatcher.CreateControl();
        _settings = _store.Load();
        _token = _store.ReadToken(_settings);
        _statusItem = new ToolStripMenuItem("Подключение…") { Enabled = false };
        _pauseItem = new ToolStripMenuItem(_settings.Paused ? "Возобновить уведомления" : "Приостановить уведомления");
        _autostartItem = new ToolStripMenuItem("Запускать вместе с Windows") { CheckOnClick = true, Checked = AutostartManager.IsEnabled() };
        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Открыть реестр", null, (_, _) => OpenRegistry(""));
        menu.Items.Add("Проверить сейчас", null, async (_, _) => await CheckNowAsync());
        menu.Items.Add(_pauseItem);
        menu.Items.Add(_autostartItem);
        menu.Items.Add("Сменить пользователя / сервер", null, (_, _) => ShowLogin());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Выход", null, (_, _) => Exit());
        _pauseItem.Click += (_, _) => TogglePause();
        _autostartItem.CheckedChanged += (_, _) => SetAutostart(_autostartItem.Checked);
        _tray = new NotifyIcon { Icon = AppIcon.Create(), Text = "Уведомления реестра", ContextMenuStrip = menu, Visible = true };
        _tray.DoubleClick += (_, _) => OpenRegistry("");

        if (_settings.Autostart && !AutostartManager.IsEnabled()) SetAutostart(true);
        if (string.IsNullOrEmpty(_token)) Ui(ShowLogin);
        else StartPolling();
    }

    private void StartPolling() => _ = PollLoopAsync(Interlocked.Increment(ref _pollGeneration), _shutdown.Token);

    private void ShowLogin()
    {
		if (_loginOpen) return;
		_loginOpen = true;
        using var form = new LoginForm(_api, _settings);
		try
		{
			if (form.ShowDialog() != DialogResult.OK || form.Result == null) return;
        _token = form.Result.Token;
        _store.SetToken(_settings, _token);
        _settings.Cursor = 0;
		_settings.CursorInitialized = false;
        _settings.Paused = false;
        _store.Save(_settings);
        _statusItem.Text = $"Подключено: {form.Result.User.Name}";
        _pauseItem.Text = "Приостановить уведомления";
        StartPolling();
		}
		finally { _loginOpen = false; }
    }

    private async Task PollLoopAsync(int generation, CancellationToken cancellationToken)
    {
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
                SetStatus("Подключено · ожидание сообщений");
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
                SetStatus("Нет связи · повторяем подключение");
                try { await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken); } catch (OperationCanceledException) { }
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

    private void SetStatus(string text) => Ui(() => _statusItem.Text = text);
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
        _popup?.Close();
        _tray.Visible = false;
        _tray.Dispose();
		_dispatcher.Dispose();
        _api.Dispose();
        _shutdown.Dispose();
        ExitThread();
    }
}
