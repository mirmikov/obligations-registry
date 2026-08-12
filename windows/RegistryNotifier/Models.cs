using System.Text.Json.Serialization;

namespace Mirt.RegistryNotifier;

internal sealed class AppSettings
{
    public string ServerUrl { get; set; } = "http://192.168.1.187:8088";
    public string Email { get; set; } = "";
    public string ProtectedToken { get; set; } = "";
    public long Cursor { get; set; }
    public bool CursorInitialized { get; set; }
    public bool Paused { get; set; }
    public bool Autostart { get; set; }
}

internal sealed class LoginResponse
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    [JsonPropertyName("expires_at")]
    public DateTimeOffset ExpiresAt { get; set; }

    [JsonPropertyName("user")]
    public DesktopUser User { get; set; } = new();
}

internal sealed class DesktopUser
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("email")]
    public string Email { get; set; } = "";
}

internal sealed class NotificationResponse
{
    [JsonPropertyName("items")]
    public List<DesktopNotification> Items { get; set; } = [];

    [JsonPropertyName("next_cursor")]
    public long NextCursor { get; set; }

    [JsonPropertyName("server_time")]
    public DateTimeOffset ServerTime { get; set; }
}

internal sealed class DesktopNotification
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "custom";

    [JsonPropertyName("title")]
    public string Title { get; set; } = "Уведомление";

    [JsonPropertyName("body")]
    public string Body { get; set; } = "";

    [JsonPropertyName("action_url")]
    public string ActionUrl { get; set; } = "";

    [JsonPropertyName("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

internal sealed class ApiException(string message, int statusCode = 0) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}
