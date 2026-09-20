using System.ComponentModel;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace SongBot.Gui;

public partial class MainWindow : Window
{
    private readonly EngineHost _engine = new();
    private Api? _api;
    private AudioMirror? _mirror;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private System.Windows.Forms.NotifyIcon? _tray;
    private bool _quitting;
    private bool _settingsLoaded;
    private bool _suppressEvents;
    private string _mode = "discord";
    private string? _lastQueueJson, _lastPlJson, _lastBlJson, _lastNpId;
    private DateTime _lastVolSend = DateTime.MinValue;
    private DateTime _lastPosReport = DateTime.MinValue;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closing += OnClosing;
        SetupTray();
    }

    private async void OnLoaded(object? sender, RoutedEventArgs e)
    {
        StBot.Text = "Starting engine…";
        var ok = await _engine.EnsureRunningAsync(s => Dispatcher.Invoke(() => StBot.Text = s));
        _api = new Api(_engine.BaseUrl);
        _mirror = new AudioMirror(_engine.BaseUrl);
        _mirror.TrackFinished += OnMirrorTrackFinished;
        if (!ok)
        {
            ShowToast("Engine failed to start — check bot.log in %APPDATA%\\twitch-song-bot", true);
        }
        _timer.Tick += async (_, _) => await Refresh();
        _timer.Start();
        await Refresh();
    }

    // ============ tray & lifecycle ============

    private void SetupTray()
    {
        _tray = new System.Windows.Forms.NotifyIcon
        {
            Text = "Song Bot",
            Visible = true,
        };
        try
        {
            var icoPath = Path.Combine(AppContext.BaseDirectory, "icon.ico");
            if (File.Exists(icoPath)) _tray.Icon = new System.Drawing.Icon(icoPath);
            else _tray.Icon = System.Drawing.SystemIcons.Application;
        }
        catch
        {
            _tray.Icon = System.Drawing.SystemIcons.Application;
        }
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("Open Song Bot", null, (_, _) => Dispatcher.Invoke(ShowFromTray));
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => Dispatcher.Invoke(() => Quit_Click(this, new RoutedEventArgs())));
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => Dispatcher.Invoke(ShowFromTray);
    }

    private void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_quitting) return;
        e.Cancel = true; // close to tray, keep playing
        Hide();
        _tray?.ShowBalloonTip(1500, "Song Bot", "Still running in the tray — the music keeps playing.",
            System.Windows.Forms.ToolTipIcon.Info);
    }

    private async void Quit_Click(object sender, RoutedEventArgs e)
    {
        if (_quitting) return;
        _quitting = true;
        _timer.Stop();
        _mirror?.Stop();
        if (_tray != null) _tray.Visible = false;
        await _engine.ShutdownAsync();
        _engine.Dispose();
        Application.Current.Shutdown();
    }

    // ============ polling & rendering ============

    private async Task Refresh()
    {
        if (_api == null) return;
        var s = await _api.State();
        if (s == null)
        {
            StBot.Text = "Engine not reachable";
            DotBot.Fill = (Brush)FindResource("Red");
            return;
        }
        try
        {
            Render(s);
        }
        catch
        {
            // never let a render hiccup kill the timer
        }
    }

    private void Render(JsonNode s)
    {
        _suppressEvents = true;
        try
        {
            var state = s["state"]?.GetValue<string>() ?? "?";
            var status = s["status"];
            var p = s["player"]!;
            var cfg = s["config"]!;

            // status pills
            StBot.Text = state switch
            {
                "running" => "Running",
                "starting" => "Starting…",
                "error" => "Error",
                _ => "Stopped",
            };
            DotBot.Fill = Pill(state == "running" ? "ok" : state == "starting" ? "warn" : "bad");
            var d = status?["discord"]?.GetValue<string>() ?? "?";
            var t = status?["twitch"]?.GetValue<string>() ?? "?";
            StDiscord.Text = "Discord: " + d;
            StTwitch.Text = "Twitch: " + t;
            DotDiscord.Fill = Pill(d.Contains("in voice") || d.Contains("logged in") || d.Contains("browser") ? "ok" : d.Contains("connecting") ? "warn" : "bad");
            DotTwitch.Fill = Pill(t.Contains("connected") ? "ok" : t.Contains("waiting") ? "warn" : "bad");
            var err = s["error"]?.GetValue<string>();
            ErrLine.Visibility = state == "error" && !string.IsNullOrEmpty(err) ? Visibility.Visible : Visibility.Collapsed;
            ErrLine.Text = "⚠ " + err;

            // mode
            _mode = p["mode"]?.GetValue<string>() ?? cfg["outputMode"]?.GetValue<string>() ?? "discord";
            StyleModeButtons();
            MirrorCheck.Visibility = _mode == "discord" ? Visibility.Visible : Visibility.Collapsed;
            ModeHint.Text = _mode == "browser"
                ? "Songs play right here on this PC. Discord is not used."
                : "Songs play in the Discord voice channel.";

            // now playing
            var cur = p["current"];
            NpTitle.Text = cur?["title"]?.GetValue<string>() ?? "Nothing playing";
            NpBy.Text = cur == null ? "" :
                $"requested by {cur["requestedBy"]?.GetValue<string>() ?? "?"} · {FmtDur(cur["durationSec"])}";
            NpSource.Text = cur?["source"]?.GetValue<string>() == "fallback" ? "· AUTO PLAYLIST" : "";
            var npId = cur?["id"]?.GetValue<string>();
            if (npId != _lastNpId)
            {
                _lastNpId = npId;
                NpThumb.Source = npId == null ? null : Bmp($"https://i.ytimg.com/vi/{npId}/mqdefault.jpg");
            }
            var paused = p["paused"]?.GetValue<bool>() ?? false;
            BtnPause.Content = paused ? "▶ Resume" : "⏸ Pause";
            var vol = p["volume"]?.GetValue<int?>() ?? cfg["defaultVolume"]?.GetValue<int>() ?? 60;
            if ((DateTime.Now - _lastVolSend).TotalSeconds > 3 && !VolSlider.IsMouseCaptureWithin)
            {
                VolSlider.Value = vol;
                VolLabel.Text = vol.ToString();
            }
            SrEnabled.IsChecked = p["enabled"]?.GetValue<bool>() ?? true;
            InterruptCheck.IsChecked = s["interruptFallback"]?.GetValue<bool>() ?? true;

            // lists
            RenderQueue(p["queue"] as JsonArray);
            RenderPlaylist(s["playlist"] as JsonArray);
            RenderBlacklist(s["blacklist"] as JsonArray);

            // settings (once)
            if (!_settingsLoaded)
            {
                LoadSettings(cfg);
                _settingsLoaded = true;
            }

            // logs
            var logs = s["logs"] as JsonArray;
            if (logs != null)
            {
                var text = string.Join("\n", logs.Select(l => l?.GetValue<string>() ?? ""));
                if (LogBox.Text != text)
                {
                    var atEnd = LogBox.VerticalOffset + LogBox.ViewportHeight >= LogBox.ExtentHeight - 24;
                    LogBox.Text = text;
                    if (atEnd) LogBox.ScrollToEnd();
                }
            }

            SyncAudio(p, cur, paused, vol);
        }
        finally
        {
            _suppressEvents = false;
        }
    }

    private void RenderQueue(JsonArray? q)
    {
        var json = q?.ToJsonString() ?? "[]";
        QCount.Text = (q?.Count ?? 0).ToString();
        if (json == _lastQueueJson) return;
        _lastQueueJson = json;
        var rows = (q ?? new JsonArray()).Select((x, i) => new Row
        {
            Index = i,
            Num = $"#{i + 1}",
            Title = $"{x?["title"]?.GetValue<string>()} · {FmtDur(x?["durationSec"])}",
            Sub = "requested by " + (x?["requestedBy"]?.GetValue<string>() ?? "?"),
            ThumbUrl = ThumbFor(x?["id"]?.GetValue<string>()),
        }).ToList();
        QueueList.ItemsSource = rows;
        QEmpty.Visibility = rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void RenderPlaylist(JsonArray? pl)
    {
        var json = pl?.ToJsonString() ?? "[]";
        PlCount.Text = (pl?.Count ?? 0).ToString();
        if (json == _lastPlJson) return;
        _lastPlJson = json;
        var rows = (pl ?? new JsonArray()).Select((x, i) => new Row
        {
            Index = i,
            Num = (i + 1).ToString(),
            Title = x?["title"]?.GetValue<string>() ?? "?",
            ThumbUrl = ThumbFor(x?["id"]?.GetValue<string>()),
        }).ToList();
        PlList.ItemsSource = rows;
        PlEmpty.Visibility = rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void RenderBlacklist(JsonArray? bl)
    {
        var json = bl?.ToJsonString() ?? "[]";
        BlCount.Text = (bl?.Count ?? 0).ToString();
        if (json == _lastBlJson) return;
        _lastBlJson = json;
        var rows = (bl ?? new JsonArray()).Select((x, i) => new Row
        {
            Index = i,
            Title = x?["title"]?.GetValue<string>() ?? "?",
        }).ToList();
        BlList.ItemsSource = rows;
        BlEmpty.Visibility = rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void LoadSettings(JsonNode cfg)
    {
        CfgDiscordToken.Password = cfg["discordToken"]?.GetValue<string>() ?? "";
        CfgVoiceChannelId.Text = cfg["voiceChannelId"]?.GetValue<string>() ?? "";
        CfgTwitchChannel.Text = cfg["twitchChannel"]?.GetValue<string>() ?? "";
        CfgTwitchUsername.Text = cfg["twitchUsername"]?.GetValue<string>() ?? "";
        CfgTwitchOauth.Password = cfg["twitchOauth"]?.GetValue<string>() ?? "";
        CfgMaxSongMinutes.Text = (cfg["maxSongMinutes"]?.GetValue<double>() ?? 10).ToString();
        CfgMaxRequestsPerUser.Text = (cfg["maxRequestsPerUser"]?.GetValue<double>() ?? 2).ToString();
        CfgMaxQueueSize.Text = (cfg["maxQueueSize"]?.GetValue<double>() ?? 0).ToString();
        CfgQueueFullMessage.Text = cfg["queueFullMessage"]?.GetValue<string>() ?? "";
        CfgPrefix.Text = cfg["prefix"]?.GetValue<string>() ?? "!";
        CfgDefaultVolume.Text = (cfg["defaultVolume"]?.GetValue<double>() ?? 60).ToString();
        CfgAudioBitrate.Text = (cfg["audioBitrate"]?.GetValue<double>() ?? 128).ToString();
    }

    // ============ native audio (In App Player + mirror) ============

    private void SyncAudio(JsonNode p, JsonNode? cur, bool paused, int vol)
    {
        if (_mirror == null) return;
        var active = _mode == "browser" || (_mode == "discord" && MirrorCheck.IsChecked == true);
        var id = cur?["id"]?.GetValue<string>();
        if (!active || id == null)
        {
            _mirror.Stop();
            return;
        }
        var posSec = p["positionSec"]?.GetValue<double?>();
        var volF = Math.Min(1f, vol / 100f);

        if (_mirror.CurrentId != id)
        {
            var startAt = _mode == "discord" && posSec is > 2 ? posSec.Value : 0;
            _mirror.Start(id, startAt, volF);
        }
        else
        {
            if (paused) _mirror.Pause();
            else _mirror.Resume();
            _mirror.SetVolume(volF);
            if (_mode == "discord" && !paused && posSec != null && Math.Abs(_mirror.PositionSec - posSec.Value) > 3)
            {
                _mirror.Start(id, posSec.Value, volF); // drift correction
            }
        }

        // In-app mode: report position for the OBS overlay's progress bar
        if (_mode == "browser" && !paused && (DateTime.Now - _lastPosReport).TotalSeconds > 2)
        {
            _lastPosReport = DateTime.Now;
            _ = _api!.Post("/api/browser/position", new { id, positionSec = _mirror.PositionSec });
        }
    }

    private void OnMirrorTrackFinished(string id)
    {
        if (_mode != "browser") return; // mirror mode: the Discord bot decides when songs end
        Dispatcher.Invoke(async () =>
        {
            try
            {
                await _api!.Post("/api/browser/ended", new { id });
                await Refresh();
            }
            catch { }
        });
    }

    // ============ actions ============

    private async void ModeDiscord_Click(object sender, RoutedEventArgs e) => await SetMode("discord");
    private async void ModeApp_Click(object sender, RoutedEventArgs e) => await SetMode("browser");

    private async Task SetMode(string m)
    {
        try
        {
            await _api!.Post("/api/config", new { outputMode = m });
            ShowToast(m == "browser" ? "In App Player mode — audio plays on this PC." : "Discord VC mode.");
            await Refresh();
        }
        catch (ApiException ex)
        {
            ShowToast(ex.Message, true);
        }
    }

    private void StyleModeButtons()
    {
        var accent = (Brush)FindResource("Accent");
        var panel = (Brush)FindResource("Panel2");
        BtnModeDiscord.Background = _mode == "discord" ? accent : panel;
        BtnModeApp.Background = _mode == "browser" ? accent : panel;
    }

    private void Mirror_Changed(object sender, RoutedEventArgs e)
    {
        if (_suppressEvents) return;
        _ = Refresh();
    }

    private async void Pause_Click(object sender, RoutedEventArgs e)
    {
        var paused = BtnPause.Content?.ToString()?.Contains("Resume") == true;
        await Try(() => _api!.Control(paused ? "resume" : "pause"));
    }

    private async void Skip_Click(object sender, RoutedEventArgs e) => await Try(() => _api!.Control("skip"));
    private async void Clear_Click(object sender, RoutedEventArgs e) => await Try(() => _api!.Control("clear"));

    private async void BlacklistCurrent_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/blacklist/add", new { current = true }), "Blacklisted & skipped.");

    private async void SrEnabled_Changed(object sender, RoutedEventArgs e)
    {
        if (_suppressEvents) return;
        await Try(() => _api!.Control("enable", SrEnabled.IsChecked == true));
    }

    private async void Interrupt_Changed(object sender, RoutedEventArgs e)
    {
        if (_suppressEvents) return;
        await Try(() => _api!.Control("interruptFallback", InterruptCheck.IsChecked == true));
    }

    private void Vol_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_suppressEvents) return;
        VolLabel.Text = ((int)VolSlider.Value).ToString();
    }

    private async void Vol_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e) => await SendVolume();
    private async void Vol_MouseUp(object sender, MouseButtonEventArgs e) => await SendVolume();

    private async Task SendVolume()
    {
        if (_suppressEvents) return;
        _lastVolSend = DateTime.Now;
        await Try(() => _api!.Control("volume", (int)VolSlider.Value));
    }

    private async void Add_Click(object sender, RoutedEventArgs e) => await AddSong();
    private async void AddBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) await AddSong();
    }

    private async Task AddSong()
    {
        var q = AddBox.Text.Trim();
        if (q.Length == 0) return;
        BtnAdd.IsEnabled = false;
        try
        {
            var r = await _api!.Post("/api/request", new { query = q });
            ShowToast($"Added: {r?["title"]?.GetValue<string>()} (#{r?["position"]?.GetValue<int>()})");
            AddBox.Text = "";
            await Refresh();
        }
        catch (ApiException ex)
        {
            ShowToast(ex.Message, true);
        }
        finally
        {
            BtnAdd.IsEnabled = true;
        }
    }

    private async void PlAdd_Click(object sender, RoutedEventArgs e) => await PlAdd();
    private async void PlAddBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) await PlAdd();
    }

    private async Task PlAdd()
    {
        var q = PlAddBox.Text.Trim();
        if (q.Length == 0) return;
        BtnPlAdd.IsEnabled = false;
        try
        {
            var r = await _api!.Post("/api/playlist/add", new { query = q });
            ShowToast($"Added to auto playlist: {r?["title"]?.GetValue<string>()}");
            PlAddBox.Text = "";
            await Refresh();
        }
        catch (ApiException ex)
        {
            ShowToast(ex.Message, true);
        }
        finally
        {
            BtnPlAdd.IsEnabled = true;
        }
    }

    private async void QueueBlacklist_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/blacklist/add", new { queueIndex = TagIndex(sender) }), "Blacklisted.");
    private async void QueueRemove_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Control("remove", TagIndex(sender)));
    private async void PlBlacklist_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/blacklist/add", new { playlistIndex = TagIndex(sender) }), "Blacklisted.");
    private async void PlRemove_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/playlist/remove", new { index = TagIndex(sender) }));
    private async void BlRemove_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/blacklist/remove", new { index = TagIndex(sender) }));

    private async void Restart_Click(object sender, RoutedEventArgs e) =>
        await Try(() => _api!.Post("/api/start"), "Bot restarted.");

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        BtnSave.IsEnabled = false;
        BtnSave.Content = "Restarting…";
        try
        {
            var r = await _api!.Post("/api/config", new
            {
                discordToken = CfgDiscordToken.Password,
                voiceChannelId = CfgVoiceChannelId.Text,
                twitchChannel = CfgTwitchChannel.Text,
                twitchUsername = CfgTwitchUsername.Text,
                twitchOauth = CfgTwitchOauth.Password,
                maxSongMinutes = CfgMaxSongMinutes.Text,
                maxRequestsPerUser = CfgMaxRequestsPerUser.Text,
                maxQueueSize = CfgMaxQueueSize.Text,
                queueFullMessage = CfgQueueFullMessage.Text,
                prefix = CfgPrefix.Text,
                defaultVolume = CfgDefaultVolume.Text,
                audioBitrate = CfgAudioBitrate.Text,
            });
            _settingsLoaded = false; // reload sanitized values
            ShowToast(r?["state"]?.GetValue<string>() == "running" ? "Saved — bot is running ✔" : "Saved.");
            await Refresh();
        }
        catch (ApiException ex)
        {
            ShowToast(ex.Message, true);
        }
        finally
        {
            BtnSave.IsEnabled = true;
            BtnSave.Content = "💾 Save & restart";
        }
    }

    private void CopyOverlay_Click(object sender, RoutedEventArgs e) => CopyText($"{_engine.BaseUrl}/overlay");
    private void CopyOverlayClean_Click(object sender, RoutedEventArgs e) => CopyText($"{_engine.BaseUrl}/overlay?clean=1");

    private void CopyText(string t)
    {
        try
        {
            Clipboard.SetText(t);
            ShowToast("Copied: " + t);
        }
        catch
        {
            ShowToast("Could not access clipboard.", true);
        }
    }

    // ============ helpers ============

    private async Task Try(Func<Task<JsonNode?>> act, string? okMsg = null)
    {
        try
        {
            await act();
            if (okMsg != null) ShowToast(okMsg);
            await Refresh();
        }
        catch (ApiException ex)
        {
            ShowToast(ex.Message, true);
        }
    }

    private static int TagIndex(object sender) =>
        int.Parse(((FrameworkElement)sender).Tag?.ToString() ?? "0");

    private Brush Pill(string kind) => (Brush)FindResource(kind switch
    {
        "ok" => "Green",
        "warn" => "Yellow",
        _ => "Red",
    });

    private static string FmtDur(JsonNode? sec)
    {
        var v = sec?.GetValue<double?>();
        if (v == null) return "?:??";
        var s = (int)Math.Round(v.Value);
        return $"{s / 60}:{s % 60:D2}";
    }

    private static string? ThumbFor(string? id) =>
        id == null ? null : $"https://i.ytimg.com/vi/{id}/mqdefault.jpg";

    private static BitmapImage Bmp(string url)
    {
        var b = new BitmapImage();
        b.BeginInit();
        b.UriSource = new Uri(url);
        b.CacheOption = BitmapCacheOption.OnLoad;
        b.EndInit();
        return b;
    }

    private void ShowToast(string msg, bool isError = false)
    {
        Toast.Text = msg;
        Toast.Foreground = (Brush)FindResource(isError ? "Red" : "Accent2");
    }

    public class Row
    {
        public int Index { get; set; }
        public string Num { get; set; } = "";
        public string Title { get; set; } = "";
        public string Sub { get; set; } = "";
        public string? ThumbUrl { get; set; }
    }
}
