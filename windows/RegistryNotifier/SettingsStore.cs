using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

namespace Mirt.RegistryNotifier;

internal sealed class SettingsStore
{
    private const int MaximumNotificationHistory = 100;
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _directory;

    public SettingsStore(string? directory = null)
    {
        _directory = directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mirt", "RegistryNotifier");
    }

    public string SettingsPath => Path.Combine(_directory, "settings.json");
    public string LogPath => Path.Combine(_directory, "notifier.log");

    private string NotificationHistoryPath(string email)
    {
        var normalized = email.Trim().ToLowerInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).Substring(0, 20);
        return Path.Combine(_directory, $"notifications-{hash}.dat");
    }

    public AppSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new AppSettings();
            return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), JsonOptions) ?? new AppSettings();
        }
        catch (Exception error)
        {
            Log("Не удалось прочитать настройки: " + error.Message);
            return new AppSettings();
        }
    }

    public void Save(AppSettings settings)
    {
        Directory.CreateDirectory(_directory);
        var temporary = SettingsPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporary, SettingsPath, true);
    }

    public string ReadToken(AppSettings settings)
    {
        try { return DataProtection.Unprotect(settings.ProtectedToken); }
        catch (Exception error)
        {
            Log("Не удалось расшифровать desktop-токен: " + error.Message);
            return "";
        }
    }

    public void SetToken(AppSettings settings, string token) => settings.ProtectedToken = DataProtection.Protect(token);

    public IReadOnlyList<DesktopNotification> LoadNotificationHistory(string email)
    {
        if (string.IsNullOrWhiteSpace(email)) return [];
        try
        {
            var path = NotificationHistoryPath(email);
            if (!File.Exists(path)) return [];
            var json = DataProtection.Unprotect(File.ReadAllText(path));
            return NormalizeNotificationHistory(JsonSerializer.Deserialize<List<DesktopNotification>>(json, JsonOptions) ?? []);
        }
        catch (Exception error)
        {
            Log("Не удалось прочитать защищённую историю уведомлений: " + error.Message);
            return [];
        }
    }

    public void SaveNotificationHistory(string email, IEnumerable<DesktopNotification> notifications)
    {
        if (string.IsNullOrWhiteSpace(email)) return;
        try
        {
            Directory.CreateDirectory(_directory);
            var path = NotificationHistoryPath(email);
            var temporary = path + ".tmp";
            var history = NormalizeNotificationHistory(notifications);
            var encrypted = DataProtection.Protect(JsonSerializer.Serialize(history, JsonOptions));
            File.WriteAllText(temporary, encrypted);
            File.Move(temporary, path, true);
        }
        catch (Exception error)
        {
            Log("Не удалось сохранить защищённую историю уведомлений: " + error.Message);
        }
    }

    public void ClearNotificationHistory(string email)
    {
        if (string.IsNullOrWhiteSpace(email)) return;
        try { File.Delete(NotificationHistoryPath(email)); }
        catch (Exception error) { Log("Не удалось очистить историю уведомлений: " + error.Message); }
    }

    internal static List<DesktopNotification> NormalizeNotificationHistory(IEnumerable<DesktopNotification> notifications)
    {
        return notifications
            .Where(item => item.Id > 0)
            .GroupBy(item => item.Id)
            .Select(group => group.Last())
            .OrderByDescending(item => item.Id)
            .Take(MaximumNotificationHistory)
            .ToList();
    }

    public void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(_directory);
            File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
            var info = new FileInfo(LogPath);
            if (info.Exists && info.Length > 2 * 1024 * 1024)
            {
                File.Move(LogPath, LogPath + ".1", true);
            }
        }
        catch { }
    }
}
