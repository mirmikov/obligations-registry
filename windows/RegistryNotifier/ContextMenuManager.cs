using Microsoft.Win32;

namespace Mirt.RegistryNotifier;

internal static class ContextMenuManager
{
    private const string VerbName = "MirtRegistryAIScan";
    private static readonly string[] Extensions = [".pdf", ".png", ".jpg", ".jpeg", ".jpe", ".jfif"];

    public static void Install()
    {
        var executable = Application.ExecutablePath;
        foreach (var extension in Extensions)
        {
            var path = $@"Software\Classes\SystemFileAssociations\{extension}\shell\{VerbName}";
            using var verb = Registry.CurrentUser.CreateSubKey(path, writable: true) ?? throw new InvalidOperationException("Не удалось создать команду Проводника.");
            verb.SetValue("MUIVerb", "Сканировать в ФинРеестре", RegistryValueKind.String);
            verb.SetValue("Icon", $"\"{executable}\",0", RegistryValueKind.String);
            verb.SetValue("Position", "Top", RegistryValueKind.String);
            using var command = verb.CreateSubKey("command", writable: true) ?? throw new InvalidOperationException("Не удалось создать команду запуска.");
            command.SetValue("", BuildCommand(executable), RegistryValueKind.String);
        }
    }

    internal static string BuildCommand(string executable) => $"\"{executable}\" --ai-scan \"%1\"";
}
