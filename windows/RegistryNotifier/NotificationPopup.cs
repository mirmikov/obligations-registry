namespace Mirt.RegistryNotifier;

internal sealed class NotificationPopup : Form
{
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 10_000 };
    private readonly Action _open;

    public NotificationPopup(DesktopNotification notification, Action open)
    {
        _open = open;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(390, 154);
        BackColor = Color.FromArgb(248, 250, 252);
        Font = new Font("Segoe UI", 9.5F);

        var accent = new Panel { Dock = DockStyle.Left, Width = 6, BackColor = Color.FromArgb(15, 118, 110) };
        var icon = new Label { Text = "●", Font = new Font("Segoe UI", 17F), ForeColor = Color.FromArgb(15, 118, 110), Location = new Point(22, 17), AutoSize = true };
        var title = new Label { Text = notification.Title, Font = new Font("Segoe UI Semibold", 11F), ForeColor = Color.FromArgb(15, 23, 42), Location = new Point(57, 18), Size = new Size(290, 25), AutoEllipsis = true };
        var body = new Label { Text = notification.Body, ForeColor = Color.FromArgb(51, 65, 85), Location = new Point(24, 53), Size = new Size(340, 57), AutoEllipsis = true };
        var time = new Label { Text = notification.CreatedAt.ToLocalTime().ToString("HH:mm"), ForeColor = Color.FromArgb(100, 116, 139), Location = new Point(24, 120), AutoSize = true };
        var hint = new Label { Text = "Нажмите, чтобы открыть", ForeColor = Color.FromArgb(15, 118, 110), Location = new Point(198, 120), AutoSize = true };
        var close = new Button { Text = "×", FlatStyle = FlatStyle.Flat, Location = new Point(353, 8), Size = new Size(28, 28), ForeColor = Color.FromArgb(100, 116, 139), TabStop = false };
        close.FlatAppearance.BorderSize = 0;
        close.Click += (_, _) => Close();
        foreach (var control in new Control[] { title, body, icon, time, hint }) control.Click += (_, _) => Open();
        Click += (_, _) => Open();
        Controls.AddRange([accent, icon, title, body, time, hint, close]);
        Paint += (_, args) => ControlPaint.DrawBorder(args.Graphics, ClientRectangle, Color.FromArgb(203, 213, 225), ButtonBorderStyle.Solid);
        _timer.Tick += (_, _) => Close();
        Shown += (_, _) =>
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(area.Right - Width - 18, area.Bottom - Height - 18);
            _timer.Start();
        };
        FormClosed += (_, _) => _timer.Dispose();
    }

    protected override bool ShowWithoutActivation => true;

    private void Open()
    {
        _timer.Stop();
        _open();
        Close();
    }
}
