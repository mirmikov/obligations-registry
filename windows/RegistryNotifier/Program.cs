using System.Threading;

namespace Mirt.RegistryNotifier;

internal static class Program
{
    private const string MutexName = "Local\\Mirt.RegistryNotifier.SingleInstance";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("--self-test", StringComparison.OrdinalIgnoreCase))
            return SelfTest.Run(args.Length > 1 ? args[1] : null);

        if (args.Length == 2 && args[0].Equals("--ai-scan", StringComparison.OrdinalIgnoreCase))
        {
            ApplicationConfiguration.Initialize();
            return AIScanCommand.Run(args[1]);
        }

        if (args.Length == 1 && args[0].Equals("--install-context-menu", StringComparison.OrdinalIgnoreCase))
        {
            ContextMenuManager.Install();
            return 0;
        }

        if (args.Length == 1 && args[0].Equals("--apply-available-update", StringComparison.OrdinalIgnoreCase))
        {
            ApplicationConfiguration.Initialize();
            return ApplyAvailableUpdate();
        }

        var afterUpdateVersion = args.Length == 2 && args[0].Equals("--after-update", StringComparison.OrdinalIgnoreCase) ? args[1] : null;

        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var created);
        if (!created) return 0;
        ApplicationConfiguration.Initialize();
        Application.Run(new NotifierApplicationContext(afterUpdateVersion));
        return 0;
    }

    private static int ApplyAvailableUpdate()
    {
        using var api = new ApiClient();
        var store = new SettingsStore();
        var settings = store.Load();
        var token = store.ReadToken(settings);
        if (string.IsNullOrEmpty(token)) return 3;
        try
        {
            var updater = new AutoUpdater(api, store);
            var update = updater.CheckAsync(settings.ServerUrl, token, CancellationToken.None).GetAwaiter().GetResult();
            if (update == null) return 2;
            updater.PrepareAndLaunchAsync(update, null, CancellationToken.None).GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception error)
        {
            store.Log("Command-line automatic update failed: " + error);
            return 1;
        }
    }
}

internal static class SelfTest
{
    public static int Run(string? resultPath)
    {
        var checks = new List<string>();
        try
        {
            var server = ApiClient.ValidateServerUrl("http://192.168.1.187:8088");
            Require(server.Host == "192.168.1.187", "private server URL");
            Require(ApiClient.ResolveActionUrl(server.AbsoluteUri, "/?page=chat&conversation=42")?.Query.Contains("conversation=42") == true, "same-site action URL");
            Require(ApiClient.ResolveActionUrl(server.AbsoluteUri, "https://evil.invalid") == null, "external action URL rejection");
            Require(ApiClient.ResolveActionUrl(server.AbsoluteUri, "//evil.invalid") == null, "protocol-relative URL rejection");
            Require(AIScanCommand.IsSupportedExtension("invoice.pdf") && AIScanCommand.IsSupportedExtension("scan.JPEG") && AIScanCommand.IsSupportedExtension("photo.jfif"), "AI scan extensions");
            Require(!AIScanCommand.IsSupportedExtension("invoice.docx") && !AIScanCommand.IsSupportedExtension("program.exe"), "unsupported AI scan extensions");
            Require(ContextMenuManager.BuildCommand(@"C:\Program Files\RegistryNotifier.exe") == "\"C:\\Program Files\\RegistryNotifier.exe\" --ai-scan \"%1\"", "context command quoting");
            Require(AutoUpdater.IsNewerVersion("1.2.0", new Version(1, 1, 0)) && !AutoUpdater.IsNewerVersion("1.1.0", new Version(1, 1, 0)), "semantic update comparison");
            Require(AutoUpdater.VersionsEqual(new Version(1, 2, 0, 0), new Version(1, 2, 0)), "release version equality");
            Require(AutoUpdater.VersionsEqual(AutoUpdater.ReadExecutableVersion(Application.ExecutablePath), AutoUpdater.CurrentVersion), "single-file executable version inspection");
            Require(AutoUpdater.QuotePowerShell("C:\\O'Brien\\app.exe") == "'C:\\O''Brien\\app.exe'", "PowerShell path quoting");
            AutoUpdater.ValidateManifest(new DesktopAppUpdate { Version = "1.2.0", DownloadUrl = "https://github.com/mirmikov/obligations-registry/releases/download/test/RegistryNotifier-win-x64.zip", Sha256 = new string('a', 64), Size = 1024 });
            var unsafeRejected = false;
            try { AutoUpdater.ValidateManifest(new DesktopAppUpdate { Version = "1.2.0", DownloadUrl = "http://example.org/app.zip", Sha256 = new string('a', 64), Size = 1024 }); } catch (ApiException) { unsafeRejected = true; }
            Require(unsafeRejected, "unsafe update manifest rejection");
            var protectedValue = DataProtection.Protect("desktop-token-test");
            Require(protectedValue != "desktop-token-test" && DataProtection.Unprotect(protectedValue) == "desktop-token-test", "Windows DPAPI round-trip");
            checks.Add("PASS: URL validation, action isolation, auto-update safety and DPAPI");
            Write(resultPath, string.Join(Environment.NewLine, checks));
            return 0;
        }
        catch (Exception error)
        {
            checks.Add("FAIL: " + error);
            Write(resultPath, string.Join(Environment.NewLine, checks));
            return 1;
        }
    }

    private static void Require(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("Self-test failed: " + name);
    }

    private static void Write(string? path, string contents)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, contents);
    }
}
