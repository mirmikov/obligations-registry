using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Mirt.RegistryNotifier;

internal static class AppIcon
{
    public static Icon Create()
    {
        using var bitmap = new Bitmap(64, 64);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(Color.Transparent);
        using var background = new SolidBrush(Color.FromArgb(15, 118, 110));
        graphics.FillRoundedRectangle(background, new Rectangle(3, 3, 58, 58), 16);
        using var pen = new Pen(Color.White, 5) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        graphics.DrawArc(pen, 16, 13, 32, 32, 205, 260);
        using var dot = new SolidBrush(Color.FromArgb(251, 191, 36));
        graphics.FillEllipse(dot, 39, 10, 13, 13);
        var handle = bitmap.GetHicon();
        try { return (Icon)Icon.FromHandle(handle).Clone(); }
        finally { DestroyIcon(handle); }
    }

    private static void FillRoundedRectangle(this Graphics graphics, Brush brush, Rectangle bounds, int radius)
    {
        using var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        graphics.FillPath(brush, path);
    }

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);
}
