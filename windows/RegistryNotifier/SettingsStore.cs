using System.Text.Json;

namespace Mirt.RegistryNotifier;

internal sealed class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly string _directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mirt", "RegistryNotifier");

    public string SettingsPath => Path.Combine(_directory, "settings.json");
    public string LogPath => Path.Combine(_directory, "notifier.log");

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
