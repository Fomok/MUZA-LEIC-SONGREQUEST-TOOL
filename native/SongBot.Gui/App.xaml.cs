using System.Windows;

namespace SongBot.Gui;

public partial class App : Application
{
    private static System.Threading.Mutex? _single;

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
        var win = new MainWindow();
        win.Show();
    }
}
