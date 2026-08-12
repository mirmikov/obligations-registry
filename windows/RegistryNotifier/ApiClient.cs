using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Mirt.RegistryNotifier;

internal sealed class ApiClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _client = new() { Timeout = TimeSpan.FromSeconds(100) };

    public async Task<LoginResponse> LoginAsync(string serverUrl, string email, string password, CancellationToken cancellationToken)
    {
        var baseUri = ValidateServerUrl(serverUrl);
        using var response = await _client.PostAsJsonAsync(new Uri(baseUri, "/api/desktop/auth/login"), new { email, password }, JsonOptions, cancellationToken);
        return await ReadAsync<LoginResponse>(response, cancellationToken);
    }

    public async Task<NotificationResponse> PollAsync(string serverUrl, string token, long cursor, int waitSeconds, bool bootstrap, CancellationToken cancellationToken)
    {
        var baseUri = ValidateServerUrl(serverUrl);
        var url = new Uri(baseUri, $"/api/desktop/notifications?after_id={cursor}&wait_seconds={Math.Clamp(waitSeconds, 0, 25)}{(bootstrap ? "&bootstrap=1" : "")}");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return await ReadAsync<NotificationResponse>(response, cancellationToken);
    }

    public async Task<AIScanStartResponse> StartAIScanAsync(string serverUrl, string token, string filePath, CancellationToken cancellationToken)
    {
        var baseUri = ValidateServerUrl(serverUrl);
        await using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var file = new StreamContent(stream);
        using var body = new MultipartFormDataContent();
        body.Add(file, "scan", Path.GetFileName(filePath));
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUri, "/api/desktop/obligations/ai-scan")) { Content = body };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return await ReadAsync<AIScanStartResponse>(response, cancellationToken);
    }

    public static Uri ValidateServerUrl(string value)
    {
        if (!Uri.TryCreate(value.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new ApiException("Укажите корректный адрес сервера, например http://192.168.1.187:8088");
        if (uri.Scheme == Uri.UriSchemeHttp && !IsPrivateHost(uri.Host))
            throw new ApiException("Незашифрованный HTTP разрешён только для локального сервера организации. Для внешнего адреса требуется HTTPS.");
        return uri;
    }

    public static Uri? ResolveActionUrl(string serverUrl, string actionUrl)
    {
        if (string.IsNullOrWhiteSpace(actionUrl)) return ValidateServerUrl(serverUrl);
        if (!actionUrl.StartsWith('/') || actionUrl.StartsWith("//") || actionUrl.IndexOfAny(['\r', '\n', '\0']) >= 0) return null;
        return Uri.TryCreate(ValidateServerUrl(serverUrl), actionUrl, out var result) && result.Host == ValidateServerUrl(serverUrl).Host && result.Port == ValidateServerUrl(serverUrl).Port ? result : null;
    }

    private static bool IsPrivateHost(string host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
        if (!IPAddress.TryParse(host, out var address)) return false;
        if (IPAddress.IsLoopback(address)) return true;
        var bytes = address.GetAddressBytes();
        return address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
               (bytes[0] == 10 || bytes[0] == 192 && bytes[1] == 168 || bytes[0] == 172 && bytes[1] is >= 16 and <= 31);
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            var value = await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken);
            return value ?? throw new ApiException("Сервер вернул пустой ответ.");
        }
        var message = $"Ошибка сервера ({(int)response.StatusCode}).";
        try
        {
            var error = await response.Content.ReadFromJsonAsync<Dictionary<string, string>>(JsonOptions, cancellationToken);
            if (error?.TryGetValue("error", out var detail) == true && !string.IsNullOrWhiteSpace(detail)) message = detail;
        }
        catch { }
        throw new ApiException(message, (int)response.StatusCode);
    }

    public void Dispose() => _client.Dispose();
}
