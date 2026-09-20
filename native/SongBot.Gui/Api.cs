using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace SongBot.Gui;

/// <summary>Thin client for the engine's local HTTP API. Uses JsonNode to stay schema-tolerant.</summary>
public class Api
{
    private readonly HttpClient _http;
    public string BaseUrl { get; }

    public Api(string baseUrl)
    {
        BaseUrl = baseUrl;
        _http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(8) };
    }

    public async Task<JsonNode?> State()
    {
        try
        {
            return JsonNode.Parse(await _http.GetStringAsync("/api/state"));
        }
        catch
        {
            return null;
        }
    }

    public async Task<JsonNode?> Post(string path, object? body = null)
    {
        try
        {
            var res = body == null
                ? await _http.PostAsync(path, new StringContent("{}", System.Text.Encoding.UTF8, "application/json"))
                : await _http.PostAsJsonAsync(path, body);
            var text = await res.Content.ReadAsStringAsync();
            var node = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            if (!res.IsSuccessStatusCode)
            {
                var err = node?["error"]?.GetValue<string>() ?? $"HTTP {(int)res.StatusCode}";
                throw new ApiException(err);
            }
            return node;
        }
        catch (ApiException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new ApiException(ex.Message);
        }
    }

    public Task<JsonNode?> Control(string action, object? value = null) =>
        Post("/api/control", new { action, value });
}

public class ApiException : Exception
{
    public ApiException(string message) : base(message) { }
}
