using System.Diagnostics;

namespace Mirt.RegistryNotifier;

internal static class AIScanCommand
{
    private const long MaximumFileSize = 20L * 1024 * 1024;
    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase) { ".pdf", ".png", ".jpg", ".jpeg", ".jpe", ".jfif" };

    public static int Run(string path)
    {
        try
        {
            var file = ValidateFile(path);
            using var form = new AIScanUploadForm(file);
            Application.Run(form);
            return form.Succeeded ? 0 : 1;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Сканирование в ФинРеестре", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }

    public static bool IsSupportedExtension(string path) => SupportedExtensions.Contains(Path.GetExtension(path));

    internal static string ValidateFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ApiException("Не выбран документ для сканирования.");
        var fullPath = Path.GetFullPath(path);
        if (!File.Exists(fullPath)) throw new ApiException("Выбранный документ не найден.");
        if (!IsSupportedExtension(fullPath)) throw new ApiException("Поддерживаются PDF, PNG и JPEG.");
        var length = new FileInfo(fullPath).Length;
        if (length < 1 || length > MaximumFileSize) throw new ApiException("Документ должен быть непустым и не больше 20 МБ.");
        return fullPath;
    }

    internal static string BuildRegistryActionUrl(string batch) => $"/?page=registry&ai_scan_batch={Uri.EscapeDataString(batch)}";

    internal static void OpenRegistry(AppSettings settings, string batch)
    {
        var uri = ApiClient.ResolveActionUrl(settings.ServerUrl, BuildRegistryActionUrl(batch)) ?? throw new ApiException("Не удалось сформировать безопасную ссылку на результат.");
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
