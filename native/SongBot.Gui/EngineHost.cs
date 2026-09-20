using System.Diagnostics;
using System.IO;
using System.Net.Http;

namespace SongBot.Gui;

/// <summary>
/// Starts and owns the bundled Node engine (hidden child process).
/// If an engine is already answering on the port (e.g. dev version running), attaches to it instead.
/// </summary>
public class EngineHost : IDisposable
{
    public const int Port = 4750;
    public string BaseUrl => $"http://127.0.0.1:{Port}";

    private Process? _proc;
    public bool StartedByUs { get; private set; }

    public async Task<bool> EnsureRunningAsync(Action<string> status)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
        if (await Responds(http))
        {
            status("Connected to an already-running engine.");
            return true;
        }

        var baseDir = AppContext.BaseDirectory;
        var engineDir = Path.Combine(baseDir, "engine");
        var nodeExe = Path.Combine(engineDir, "node.exe");
        var entry = Path.Combine(engineDir, "src", "index.js");
        if (!File.Exists(nodeExe) || !File.Exists(entry))
        {
            // dev fallback: repo checkout next to native/ with system node
            var repoRoot = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", ".."));
            var devEntry = Path.Combine(repoRoot, "src", "index.js");
            if (File.Exists(devEntry))
            {
                nodeExe = "node";
                entry = devEntry;
                engineDir = repoRoot;
            }
            else
            {
                status("Engine files not found (engine\\src\\index.js).");
                return false;
            }
        }

        status("Starting engine...");
        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = $"\"{entry}\"",
            WorkingDirectory = engineDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.EnvironmentVariables["SONGBOT_EMBEDDED"] = "1";
        psi.EnvironmentVariables["SONGBOT_DATA"] =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "twitch-song-bot");

        try
        {
            _proc = Process.Start(psi);
            StartedByUs = true;
        }
        catch (Exception ex)
        {
            status("Could not start engine: " + ex.Message);
            return false;
        }

        for (int i = 0; i < 60; i++)
        {
            await Task.Delay(500);
            if (_proc != null && _proc.HasExited)
            {
                status($"Engine exited early (code {_proc.ExitCode}). See bot.log in %APPDATA%\\twitch-song-bot.");
                return false;
            }
            if (await Responds(http))
            {
                status("Engine running.");
                return true;
            }
        }
        status("Engine did not answer in time.");
        return false;
    }

    private async Task<bool> Responds(HttpClient http)
    {
        try
        {
            var r = await http.GetAsync($"{BaseUrl}/api/state");
            return r.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task ShutdownAsync()
    {
        if (!StartedByUs) return;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            await http.PostAsync($"{BaseUrl}/api/shutdown", null);
        }
        catch { }
        try
        {
            if (_proc != null && !_proc.HasExited && !_proc.WaitForExit(3000))
            {
                _proc.Kill(entireProcessTree: true);
            }
        }
        catch { }
    }

    public void Dispose()
    {
        try
        {
            if (StartedByUs && _proc != null && !_proc.HasExited) _proc.Kill(entireProcessTree: true);
        }
        catch { }
    }
}
