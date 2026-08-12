using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;

namespace Mirt.RegistryNotifier;

internal sealed class AutoUpdater
{
    private const long MaximumPackageSize = 250L * 1024 * 1024;
    private readonly ApiClient _api;
    private readonly SettingsStore _store;

    public AutoUpdater(ApiClient api, SettingsStore store)
    {
        _api = api;
        _store = store;
    }

    internal static Version CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);

    public async Task<DesktopAppUpdate?> CheckAsync(string serverUrl, string token, CancellationToken cancellationToken)
    {
        var manifest = await _api.GetAppUpdateAsync(serverUrl, token, cancellationToken);
        ValidateManifest(manifest);
        return IsNewerVersion(manifest.Version, CurrentVersion) ? manifest : null;
    }

    public async Task PrepareAndLaunchAsync(DesktopAppUpdate manifest, IProgress<int>? progress, CancellationToken cancellationToken)
    {
        ValidateManifest(manifest);
        var updateRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mirt", "RegistryNotifier", "Updates", manifest.Version + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(updateRoot);
        var packagePath = Path.Combine(updateRoot, "RegistryNotifier-win-x64.zip");
        var extractedExecutable = Path.Combine(updateRoot, "RegistryNotifier.exe");
        try
        {
            await DownloadAndVerifyAsync(manifest, packagePath, progress, cancellationToken);
            ExtractExecutable(packagePath, extractedExecutable);
            var extractedVersion = ReadExecutableVersion(extractedExecutable);
            if (!VersionsEqual(extractedVersion, new Version(manifest.Version))) throw new ApiException("Версия приложения внутри пакета не совпадает с опубликованной версией.");
            LaunchReplacement(extractedExecutable, Application.ExecutablePath, manifest.Version, updateRoot);
        }
        catch
        {
            try { Directory.Delete(updateRoot, true); } catch { }
            throw;
        }
    }

    private async Task DownloadAndVerifyAsync(DesktopAppUpdate manifest, string packagePath, IProgress<int>? progress, CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Mirt-RegistryNotifier/" + CurrentVersion.ToString(3));
        using var response = await client.GetAsync(manifest.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is long advertised && advertised != manifest.Size) throw new ApiException("Размер загружаемого обновления не совпадает с опубликованным.");
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var destination = new FileStream(packagePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true);
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total += read;
            if (total > MaximumPackageSize || total > manifest.Size) throw new ApiException("Пакет обновления превышает допустимый размер.");
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            sha.AppendData(buffer, 0, read);
            progress?.Report((int)Math.Min(100, total * 100 / manifest.Size));
        }
        await destination.FlushAsync(cancellationToken);
        var actualHash = Convert.ToHexString(sha.GetHashAndReset());
        if (total != manifest.Size || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actualHash), Convert.FromHexString(manifest.Sha256)))
            throw new ApiException("Контрольная сумма обновления не совпала. Установка отменена.");
    }

    internal static void ExtractExecutable(string packagePath, string destinationPath)
    {
        using var archive = ZipFile.OpenRead(packagePath);
        var matches = archive.Entries.Where(entry => string.Equals(entry.FullName.Replace('\\', '/'), "RegistryNotifier.exe", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length != 1 || matches[0].Length < 1024 || matches[0].Length > MaximumPackageSize) throw new ApiException("Пакет обновления имеет некорректную структуру.");
        matches[0].ExtractToFile(destinationPath, false);
    }

    internal static bool IsNewerVersion(string candidate, Version current)
    {
        return Version.TryParse(candidate, out var parsed) && parsed > current;
    }

    internal static bool VersionsEqual(Version left, Version right) => left.Major == right.Major && left.Minor == right.Minor && Math.Max(0, left.Build) == Math.Max(0, right.Build);

    internal static Version ReadExecutableVersion(string executablePath)
    {
        var versionText = FileVersionInfo.GetVersionInfo(executablePath).FileVersion;
        return Version.TryParse(versionText, out var version) ? version : throw new ApiException("Не удалось проверить версию приложения внутри пакета.");
    }

    internal static void ValidateManifest(DesktopAppUpdate manifest)
    {
        if (!Version.TryParse(manifest.Version, out var parsed) || parsed.Build < 0 || parsed.Revision > 0 || !Uri.TryCreate(manifest.DownloadUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || !uri.AbsolutePath.StartsWith("/mirmikov/obligations-registry/releases/download/", StringComparison.Ordinal) || manifest.Sha256.Length != 64 || !manifest.Sha256.All(Uri.IsHexDigit) || manifest.Size < 1 || manifest.Size > MaximumPackageSize)
            throw new ApiException("Сервер вернул небезопасное описание обновления.");
    }

    internal static string QuotePowerShell(string value) => "'" + value.Replace("'", "''") + "'";

    private void LaunchReplacement(string sourceExecutable, string targetExecutable, string version, string updateRoot)
    {
        var scriptPath = Path.Combine(updateRoot, "apply-update.ps1");
        var backupPath = targetExecutable + ".previous";
        var stagedPath = targetExecutable + ".updating";
        var logPath = _store.LogPath;
        var script = string.Join(Environment.NewLine, new[]
        {
            "$ErrorActionPreference = 'Stop'",
            "$waitForProcessId = " + Environment.ProcessId,
            "$source = " + QuotePowerShell(sourceExecutable),
            "$target = " + QuotePowerShell(targetExecutable),
            "$backup = " + QuotePowerShell(backupPath),
            "$staged = " + QuotePowerShell(stagedPath),
            "$log = " + QuotePowerShell(logPath),
            "try {",
            "    Wait-Process -Id $waitForProcessId -Timeout 60 -ErrorAction SilentlyContinue",
            "    if (Get-Process -Id $waitForProcessId -ErrorAction SilentlyContinue) { throw 'The previous application process is still running.' }",
            "    Copy-Item -LiteralPath $source -Destination $staged -Force",
            "    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }",
            "    Move-Item -LiteralPath $target -Destination $backup -Force",
            "    Move-Item -LiteralPath $staged -Destination $target -Force",
            "    Start-Process -FilePath $target -ArgumentList @('--after-update', " + QuotePowerShell(version) + ")",
            "    Start-Sleep -Seconds 2",
            "    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }",
            "    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' Automatic update completed: " + version + "')",
            "} catch {",
            "    if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target -Force }",
            "    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }",
            "    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' Automatic update failed: ' + $_.Exception.Message)",
            "    if (Test-Path -LiteralPath $target) { Start-Process -FilePath $target }",
            "    exit 1",
            "}",
        });
        File.WriteAllText(scriptPath, script, new System.Text.UTF8Encoding(true));
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath }) start.ArgumentList.Add(argument);
        _ = Process.Start(start) ?? throw new ApiException("Не удалось запустить установку обновления.");
    }
}
