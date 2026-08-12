namespace Mirt.RegistryNotifier;

internal sealed class LoginForm : Form
{
    private readonly TextBox _server = new();
    private readonly TextBox _email = new();
    private readonly TextBox _password = new() { UseSystemPasswordChar = true };
    private readonly Label _status = new() { AutoSize = false, ForeColor = Color.FromArgb(185, 28, 28), Height = 38 };
    private readonly Button _login = new() { Text = "Войти", Height = 42 };
    private readonly ApiClient _api;
    private readonly AppSettings _settings;

    public LoginResponse? Result { get; private set; }

    public LoginForm(ApiClient api, AppSettings settings)
    {
        _api = api;
        _settings = settings;
        Text = "Уведомления реестра — вход";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(480, 410);
        BackColor = Color.FromArgb(244, 248, 247);
        Font = new Font("Segoe UI", 10F);
        Icon = AppIcon.Create();

        var title = new Label { Text = "Реестр обязательств", Font = new Font("Segoe UI Semibold", 18F), ForeColor = Color.FromArgb(15, 118, 110), AutoSize = true };
        var subtitle = new Label { Text = "Войдите один раз — приложение останется в трее и будет показывать новые сообщения.", AutoSize = false, Width = 410, Height = 54, ForeColor = Color.FromArgb(71, 85, 105) };
        _server.Text = settings.ServerUrl;
        _email.Text = settings.Email;
        _server.PlaceholderText = "http://192.168.1.187:8088";
        _email.PlaceholderText = "name@mirt-med.ru";
        _password.PlaceholderText = "Пароль";
        foreach (var input in new[] { _server, _email, _password }) { input.Width = 410; input.Height = 34; }
        _login.Width = 410;
        _login.BackColor = Color.FromArgb(15, 118, 110);
        _login.ForeColor = Color.White;
        _login.FlatStyle = FlatStyle.Flat;
        _login.FlatAppearance.BorderSize = 0;
        _login.Click += async (_, _) => await LoginAsync();
        AcceptButton = _login;

        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(34, 30, 34, 24) };
        panel.Controls.Add(title);
        panel.Controls.Add(subtitle);
        panel.Controls.Add(Field("Адрес сервера", _server));
        panel.Controls.Add(Field("Рабочая почта", _email));
        panel.Controls.Add(Field("Пароль", _password));
        panel.Controls.Add(_status);
        panel.Controls.Add(_login);
        Controls.Add(panel);
    }

    private static Control Field(string label, Control input)
    {
        var box = new Panel { Width = 410, Height = 65, Margin = new Padding(0, 4, 0, 0) };
        box.Controls.Add(input);
        input.Location = new Point(0, 26);
        box.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = Color.FromArgb(51, 65, 85), Location = new Point(0, 2) });
        return box;
    }

    private async Task LoginAsync()
    {
        _status.Text = "";
        _login.Enabled = false;
        _login.Text = "Подключаемся…";
        try
        {
            Result = await _api.LoginAsync(_server.Text, _email.Text, _password.Text, CancellationToken.None);
            _settings.ServerUrl = ApiClient.ValidateServerUrl(_server.Text).GetLeftPart(UriPartial.Authority);
            _settings.Email = Result.User.Email;
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception error)
        {
            _status.Text = error.Message;
        }
        finally
        {
            _login.Enabled = true;
            _login.Text = "Войти";
        }
    }
}
