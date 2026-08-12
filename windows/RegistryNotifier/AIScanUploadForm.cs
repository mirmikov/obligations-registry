namespace Mirt.RegistryNotifier;

internal sealed class AIScanUploadForm : Form
{
    private readonly string _filePath;
    private readonly SettingsStore _store = new();
    private readonly ApiClient _api = new();
    private readonly AppSettings _settings;
    private readonly Label _title = new() { AutoSize = false, TextAlign = ContentAlignment.MiddleCenter };
    private readonly Label _status = new() { AutoSize = false, TextAlign = ContentAlignment.TopCenter };
    private readonly ProgressBar _progress = new() { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 24 };
    private readonly Button _close = new() { Text = "Закрыть", Visible = false };
    private readonly CancellationTokenSource _shutdown = new();
    private string _token;

    public bool Succeeded { get; private set; }

    public AIScanUploadForm(string filePath)
    {
        _filePath = filePath;
        _settings = _store.Load();
        _token = _store.ReadToken(_settings);
        Text = "Сканирование в ФинРеестре";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(520, 235);
        BackColor = Color.FromArgb(244, 248, 247);
        Font = new Font("Segoe UI", 10F);
        Icon = AppIcon.Create();

        _title.Text = "Отправляем документ в AI-сканирование";
        _title.Font = new Font("Segoe UI Semibold", 16F);
        _title.ForeColor = Color.FromArgb(15, 118, 110);
        _title.SetBounds(30, 28, 460, 42);
        _status.Text = Path.GetFileName(filePath);
        _status.ForeColor = Color.FromArgb(71, 85, 105);
        _status.SetBounds(40, 80, 440, 58);
        _progress.SetBounds(55, 145, 410, 12);
        _close.SetBounds(160, 174, 200, 38);
        _close.Click += (_, _) => Close();
        Controls.AddRange([_title, _status, _progress, _close]);
        Shown += async (_, _) => await UploadAsync();
        FormClosing += (_, _) => _shutdown.Cancel();
    }

    private async Task UploadAsync()
    {
        try
        {
            if (!EnsureLogin()) { Close(); return; }
            AIScanStartResponse result;
            try
            {
                result = await _api.StartAIScanAsync(_settings.ServerUrl, _token, _filePath, _shutdown.Token);
            }
            catch (ApiException error) when (error.StatusCode == 401)
            {
                _token = "";
                _settings.ProtectedToken = "";
                _store.Save(_settings);
                if (!EnsureLogin()) { Close(); return; }
                result = await _api.StartAIScanAsync(_settings.ServerUrl, _token, _filePath, _shutdown.Token);
            }
            _title.Text = "Документ принят";
            _status.Text = $"Начато распознавание {result.Pages} стр. Результат откроется в реестре.";
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 100;
            AIScanCommand.OpenRegistry(_settings, result.Batch);
            Succeeded = true;
            await Task.Delay(900, _shutdown.Token);
            Close();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            _store.Log("AI scan from Explorer failed: " + error);
            _title.Text = "Не удалось начать сканирование";
            _title.ForeColor = Color.FromArgb(185, 28, 28);
            _status.Text = error.Message;
            _progress.Visible = false;
            _close.Visible = true;
        }
    }

    private bool EnsureLogin()
    {
        if (!string.IsNullOrEmpty(_token)) return true;
        using var login = new LoginForm(_api, _settings);
        if (login.ShowDialog(this) != DialogResult.OK || login.Result == null) return false;
        _token = login.Result.Token;
        _store.SetToken(_settings, _token);
        _store.Save(_settings);
        return true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _shutdown.Dispose();
            _api.Dispose();
        }
        base.Dispose(disposing);
    }
}
