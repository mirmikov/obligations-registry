namespace Mirt.RegistryNotifier;

internal sealed class NotificationCenterForm : Form
{
    private readonly Action<string> _openAction;
    private readonly Action _clearHistory;
    private readonly TextBox _search = new() { PlaceholderText = "Поиск по заголовку и тексту…" };
    private readonly ListView _list = new() { View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false };
    private readonly Label _connection = new() { AutoSize = false, TextAlign = ContentAlignment.MiddleRight };
    private readonly Label _counter = new() { AutoSize = true };
    private readonly Button _open = new() { Text = "Открыть", Height = 38, Enabled = false };
    private readonly Button _clear = new() { Text = "Очистить историю", Height = 38 };
    private List<DesktopNotification> _items = [];

    public NotificationCenterForm(IReadOnlyList<DesktopNotification> items, string connectionStatus, DateTimeOffset? lastSync, Action<string> openAction, Action clearHistory)
    {
        _openAction = openAction;
        _clearHistory = clearHistory;
        Text = "Центр уведомлений ФинРеестра";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(720, 470);
        ClientSize = new Size(900, 590);
        BackColor = Color.FromArgb(244, 248, 247);
        Font = new Font("Segoe UI", 10F);
        Icon = AppIcon.Create();

        var title = new Label { Text = "Центр уведомлений", Font = new Font("Segoe UI Semibold", 20F), ForeColor = Color.FromArgb(26, 74, 70), AutoSize = true };
        var subtitle = new Label { Text = $"Версия {AutoUpdater.CurrentVersion.ToString(3)} · Последние 100 уведомлений сохраняются на этом компьютере в зашифрованном виде.", ForeColor = Color.FromArgb(71, 85, 105), AutoSize = true };
        _connection.ForeColor = Color.FromArgb(71, 98, 94);

        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Padding = new Padding(0) };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
        heading.Controls.Add(title, 0, 0);
        heading.Controls.Add(_connection, 1, 0);
        heading.Controls.Add(subtitle, 0, 1);
        heading.SetColumnSpan(subtitle, 2);

        _search.Dock = DockStyle.Fill;
        _search.Margin = new Padding(0, 0, 0, 10);
        _search.TextChanged += (_, _) => RebuildList();

        _list.Dock = DockStyle.Fill;
        _list.BorderStyle = BorderStyle.FixedSingle;
        _list.BackColor = Color.White;
        _list.Columns.Add("Время", 120);
        _list.Columns.Add("Тип", 120);
        _list.Columns.Add("Заголовок", 230);
        _list.Columns.Add("Сообщение", 390);
        _list.SelectedIndexChanged += (_, _) => _open.Enabled = _list.SelectedItems.Count == 1;
        _list.DoubleClick += (_, _) => OpenSelected();
        _list.KeyDown += (_, eventArgs) => { if (eventArgs.KeyCode == Keys.Enter) OpenSelected(); };

        _counter.ForeColor = Color.FromArgb(71, 85, 105);
        _counter.TextAlign = ContentAlignment.MiddleLeft;
        _open.BackColor = Color.FromArgb(15, 118, 110);
        _open.ForeColor = Color.White;
        _open.FlatStyle = FlatStyle.Flat;
        _open.FlatAppearance.BorderSize = 0;
        _open.Click += (_, _) => OpenSelected();
        _clear.BackColor = Color.White;
        _clear.ForeColor = Color.FromArgb(57, 83, 80);
        _clear.FlatStyle = FlatStyle.Flat;
        _clear.FlatAppearance.BorderColor = Color.FromArgb(198, 214, 209);
        _clear.Click += (_, _) => ClearHistory();
        var openRegistry = new Button { Text = "Открыть реестр", Height = 38, BackColor = Color.White, ForeColor = Color.FromArgb(57, 83, 80), FlatStyle = FlatStyle.Flat };
        openRegistry.FlatAppearance.BorderColor = Color.FromArgb(198, 214, 209);
        openRegistry.Click += (_, _) => _openAction("");

        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, Padding = new Padding(0, 8, 0, 0) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        footer.Controls.Add(_counter, 0, 0);
        footer.Controls.Add(_clear, 1, 0);
        footer.Controls.Add(openRegistry, 2, 0);
        footer.Controls.Add(_open, 3, 0);
        foreach (var button in new[] { _clear, openRegistry, _open }) button.Dock = DockStyle.Fill;

        var content = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, Padding = new Padding(26) };
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
        content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        content.Controls.Add(heading, 0, 0);
        content.Controls.Add(_search, 0, 1);
        content.Controls.Add(_list, 0, 2);
        content.Controls.Add(footer, 0, 3);
        Controls.Add(content);

        UpdateState(items, connectionStatus, lastSync);
    }

    public void UpdateState(IReadOnlyList<DesktopNotification> items, string connectionStatus, DateTimeOffset? lastSync)
    {
        if (InvokeRequired) { BeginInvoke(() => UpdateState(items, connectionStatus, lastSync)); return; }
        _items = items.OrderByDescending(item => item.Id).ToList();
        _connection.Text = lastSync.HasValue
            ? $"{connectionStatus}\nПоследняя синхронизация: {lastSync.Value.ToLocalTime():HH:mm:ss}"
            : connectionStatus;
        RebuildList();
    }

    private void RebuildList()
    {
        var query = _search.Text.Trim();
        var visible = _items.Where(item => query.Length == 0 || SearchText(item).Contains(query, StringComparison.CurrentCultureIgnoreCase)).ToList();
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            foreach (var notification in visible)
            {
                var item = new ListViewItem(notification.CreatedAt.ToLocalTime().ToString("dd.MM HH:mm")) { Tag = notification };
                item.SubItems.Add(KindLabel(notification.Kind));
                item.SubItems.Add(notification.Title);
                item.SubItems.Add(SingleLine(notification.Body));
                _list.Items.Add(item);
            }
        }
        finally { _list.EndUpdate(); }
        _counter.Text = query.Length == 0 ? $"Сохранено уведомлений: {_items.Count}" : $"Найдено: {visible.Count} из {_items.Count}";
        _clear.Enabled = _items.Count > 0;
        _open.Enabled = _list.SelectedItems.Count == 1;
    }

    private void OpenSelected()
    {
        if (_list.SelectedItems.Count != 1 || _list.SelectedItems[0].Tag is not DesktopNotification notification) return;
        _openAction(notification.ActionUrl);
    }

    private void ClearHistory()
    {
        if (_items.Count == 0) return;
        var result = MessageBox.Show(this, "Удалить локальную историю уведомлений? Серверные сообщения и счета не изменятся.", "Центр уведомлений", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (result != DialogResult.Yes) return;
        _clearHistory();
    }

    internal static string KindLabel(string kind)
    {
        kind ??= "";
        if (kind.Equals("chat.message", StringComparison.OrdinalIgnoreCase)) return "Сообщение";
        if (kind.Contains("invoice", StringComparison.OrdinalIgnoreCase) || kind.Contains("accounting", StringComparison.OrdinalIgnoreCase)) return "Счёт";
        if (kind.Contains("update", StringComparison.OrdinalIgnoreCase)) return "Обновление";
        if (kind.Contains("approval", StringComparison.OrdinalIgnoreCase) || kind.Contains("payment", StringComparison.OrdinalIgnoreCase)) return "Платёж";
        return "Уведомление";
    }

    private static string SearchText(DesktopNotification item) => $"{item.Title ?? ""} {item.Body ?? ""} {KindLabel(item.Kind)}";
    private static string SingleLine(string value) => string.Join(" ", (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
}
