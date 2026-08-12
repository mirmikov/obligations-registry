namespace Mirt.RegistryNotifier;

internal sealed class UpdateAvailableForm : Form
{
    private readonly Button _update = new() { Text = "Обновить", Height = 42 };
    private readonly Button _later = new() { Text = "Позже", Height = 42 };
    private readonly Label _status = new() { AutoSize = false, Height = 24, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.FromArgb(71, 98, 94) };
    private readonly ProgressBar _progress = new() { Height = 8, Minimum = 0, Maximum = 100, Visible = false };

    public event Func<Task>? UpdateRequested;

    public UpdateAvailableForm(DesktopAppUpdate update)
    {
        Text = "Обновление ФинРеестра";
        Width = 520;
        Height = 360;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(247, 250, 249);
        Font = new Font("Segoe UI", 10F);

        var title = new Label { Text = "Доступно обновление", Font = new Font("Segoe UI Semibold", 18F), ForeColor = Color.FromArgb(26, 74, 70), AutoSize = true };
        var version = new Label { Text = $"Версия {AutoUpdater.CurrentVersion.ToString(3)}  →  {update.Version}", ForeColor = Color.FromArgb(43, 118, 100), AutoSize = true };
        var notes = new Label { Text = update.ReleaseNotes, ForeColor = Color.FromArgb(67, 87, 85), AutoSize = false, Height = 80, Padding = new Padding(0, 8, 0, 0) };
        _update.BackColor = Color.FromArgb(15, 118, 110); _update.ForeColor = Color.White; _update.FlatStyle = FlatStyle.Flat; _update.FlatAppearance.BorderSize = 0;
        _later.BackColor = Color.White; _later.ForeColor = Color.FromArgb(57, 83, 80); _later.FlatStyle = FlatStyle.Flat; _later.FlatAppearance.BorderColor = Color.FromArgb(198, 214, 209);
        _update.Click += async (_, _) => await BeginUpdateAsync();
        _later.Click += (_, _) => Close();
        AcceptButton = _update;
        CancelButton = _later;

        var buttons = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Height = 42 };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        buttons.Controls.Add(_later, 0, 0); buttons.Controls.Add(_update, 1, 0);
        _later.Dock = DockStyle.Fill; _update.Dock = DockStyle.Fill;
        var content = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28), RowCount = 7 };
        content.RowStyles.Add(new RowStyle(SizeType.AutoSize)); content.RowStyles.Add(new RowStyle(SizeType.AutoSize)); content.RowStyles.Add(new RowStyle(SizeType.Absolute, 95)); content.RowStyles.Add(new RowStyle(SizeType.Absolute, 8)); content.RowStyles.Add(new RowStyle(SizeType.Absolute, 30)); content.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); content.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        content.Controls.Add(title, 0, 0); content.Controls.Add(version, 0, 1); content.Controls.Add(notes, 0, 2); content.Controls.Add(_progress, 0, 3); content.Controls.Add(_status, 0, 4); content.Controls.Add(buttons, 0, 6);
        title.Margin = new Padding(0, 0, 0, 8); version.Margin = new Padding(0, 0, 0, 6); buttons.Margin = new Padding(0);
        Controls.Add(content);
    }

    public void ReportProgress(int value)
    {
        if (InvokeRequired) { BeginInvoke(() => ReportProgress(value)); return; }
        _progress.Value = Math.Clamp(value, 0, 100);
        _status.Text = value < 100 ? $"Загрузка обновления: {value}%" : "Проверяем и устанавливаем…";
    }

    public void ShowError(string message)
    {
        _progress.Visible = false;
        _status.Text = message;
        _status.ForeColor = Color.FromArgb(176, 61, 48);
        _update.Enabled = true; _later.Enabled = true; _update.Text = "Повторить";
    }

    private async Task BeginUpdateAsync()
    {
        if (UpdateRequested == null) return;
        _update.Enabled = false; _later.Enabled = false; _update.Text = "Обновляем…"; _progress.Visible = true; _status.Text = "Подготавливаем обновление…";
        foreach (var handler in UpdateRequested.GetInvocationList().Cast<Func<Task>>()) await handler();
    }
}
