using System.IO;
using System.Windows;

namespace SongBot.Gui;

public partial class App : Application
{
    private static System.Threading.Mutex? _single;

    public App()
    {
        // Never die silently: log every crash and tell the user.
        AppDomain.CurrentDomain.UnhandledException += (_, ev) => LogCrash(ev.ExceptionObject as Exception);
        DispatcherUnhandledException += (_, ev) =>
        {
            LogCrash(ev.Exception);
            ev.Handled = false;
        };
        TaskScheduler.UnobservedTaskException += (_, ev) => LogCrash(ev.Exception);
    }

    public static void LogCrash(Exception? ex)
    {
        var text = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {ex}\n";
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "twitch-song-bot");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "gui-crash.log"), text);
        }
        catch { }
        try
        {
            MessageBox.Show(
                "Song Bot hit an unexpected error:\n\n" + (ex?.Message ?? "unknown") +
                "\n\nDetails were written to %APPDATA%\\twitch-song-bot\\gui-crash.log",
                "Song Bot", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch { }
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        // single instance
        _single = new System.Threading.Mutex(true, "SongBotNativeGui", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Song Bot is already running (check the tray).", "Song Bot",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);
        try
        {
            var win = new MainWindow();
            win.Show();
        }
        catch (Exception ex)
        {
            LogCrash(ex);
            Shutdown();
        }
    }
}
