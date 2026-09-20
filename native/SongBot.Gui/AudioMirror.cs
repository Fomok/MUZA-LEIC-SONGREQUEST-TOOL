using System.IO;
using System.Net.Http;
using NAudio.Wave;

namespace SongBot.Gui;

/// <summary>
/// Plays the engine's current song through the PC speakers by streaming raw PCM
/// (s16le 48kHz stereo) from /api/audio/:id/pcm. Used for In App Player mode and
/// for mirroring the Discord bot.
/// </summary>
public class AudioMirror : IDisposable
{
    private readonly string _baseUrl;
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private WaveOutEvent? _out;
    private BufferedWaveProvider? _buffer;
    private VolumeWaveProvider16? _volume;
    private CancellationTokenSource? _cts;
    private long _bytesRead;
    private double _startPos;
    private bool _streamEnded;

    public string? CurrentId { get; private set; }
    public bool Playing => _out?.PlaybackState == PlaybackState.Playing;
    public event Action<string>? TrackFinished; // fires when the stream is fully played out

    public AudioMirror(string baseUrl) => _baseUrl = baseUrl;

    /// <summary>Playback position = bytes actually played (downloaded minus what still sits in the buffer).</summary>
    public double PositionSec
    {
        get
        {
            var played = Interlocked.Read(ref _bytesRead) - (_buffer?.BufferedBytes ?? 0);
            return _startPos + Math.Max(0, played) / (48000.0 * 2 * 2);
        }
    }

    public void Start(string id, double posSec, float volume)
    {
        Stop();
        CurrentId = id;
        _startPos = posSec;
        _bytesRead = 0;
        _streamEnded = false;

        var fmt = new WaveFormat(48000, 16, 2);
        _buffer = new BufferedWaveProvider(fmt)
        {
            BufferDuration = TimeSpan.FromSeconds(12),
            DiscardOnBufferOverflow = false,
        };
        _volume = new VolumeWaveProvider16(_buffer) { Volume = Math.Clamp(volume, 0f, 1f) };
        _out = new WaveOutEvent { DesiredLatency = 200 };
        _out.Init(_volume);
        _out.PlaybackStopped += (_, _) => { };
        _out.Play();

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                var url = $"{_baseUrl}/api/audio/{Uri.EscapeDataString(id)}/pcm?pos={posSec.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}";
                using var stream = await _http.GetStreamAsync(url, ct);
                var chunk = new byte[16384];
                int n;
                while ((n = await stream.ReadAsync(chunk, ct)) > 0)
                {
                    // back-pressure: wait while the buffer is nearly full
                    while (!ct.IsCancellationRequested &&
                           _buffer!.BufferedBytes > _buffer.BufferLength - chunk.Length * 2)
                    {
                        await Task.Delay(100, ct);
                    }
                    if (ct.IsCancellationRequested) return;
                    _buffer!.AddSamples(chunk, 0, n);
                    Interlocked.Add(ref _bytesRead, n);
                }
                _streamEnded = true;
                // drain, then report the song as finished
                while (!ct.IsCancellationRequested && _buffer!.BufferedBytes > 0)
                {
                    await Task.Delay(150, ct);
                }
                if (!ct.IsCancellationRequested)
                {
                    var finished = CurrentId;
                    if (finished != null) TrackFinished?.Invoke(finished);
                }
            }
            catch
            {
                // cancelled or network hiccup — state polling recovers
            }
        }, ct);
    }

    public void Pause() => _out?.Pause();

    public void Resume()
    {
        if (_out?.PlaybackState == PlaybackState.Paused) _out.Play();
    }

    public void SetVolume(float v)
    {
        if (_volume != null) _volume.Volume = Math.Clamp(v, 0f, 1f);
    }

    public void Stop()
    {
        try
        {
            _cts?.Cancel();
        }
        catch { }
        _cts = null;
        try
        {
            _out?.Stop();
            _out?.Dispose();
        }
        catch { }
        _out = null;
        _buffer = null;
        _volume = null;
        CurrentId = null;
    }

    public void Dispose() => Stop();
}
