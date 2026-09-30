# Zmanim screensaver for Windows.
#
# Runs in the background (started at log-on by Task Scheduler - see
# section 8 of zmanim-screen-documentation.md). After the laptop has had no
# keyboard/mouse input for -IdleMinutes, it opens the Zmanim screen full-screen
# in Chrome's kiosk mode; the first keypress or mouse movement closes it again,
# like a real screensaver.
#
# Chrome runs with its own separate profile, so it never touches your normal
# Chrome windows, tabs, or sign-in - and closing the screensaver only ever
# closes that one kiosk window.
#
# Try it by hand first:
#   powershell -ExecutionPolicy Bypass -File scripts\zmanim-screensaver.ps1 -Test
#       prints how long you've been idle, without opening anything
#   powershell -ExecutionPolicy Bypass -File scripts\zmanim-screensaver.ps1 -IdleMinutes 1
#       the real thing, with a 1-minute timeout (Ctrl+C in that window to stop)

param(
    [string]$Url = 'http://localhost:8000',  # or http://<pi-ip-address>:8000 to show the Pi's screen
    [int]$IdleMinutes = 10,
    [switch]$Test
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ZmanimIdle {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);

    // Tick count (ms since boot) of the last keyboard/mouse input.
    public static uint LastInputTick() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        GetLastInputInfo(ref info);
        return info.dwTime;
    }

    // Milliseconds since the last input. Unsigned subtraction keeps this
    // correct when the tick counter wraps around (every ~49 days of uptime).
    public static uint IdleMs() {
        return unchecked((uint)Environment.TickCount - LastInputTick());
    }

    // True when the foreground window covers its whole monitor - a full-screen
    // video, game, or presentation - so the screensaver shouldn't cover it.
    // The desktop itself also spans the monitor, so it's excluded by class name.
    public static bool ForegroundIsFullScreen() {
        IntPtr hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero) return false;

        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        string name = cls.ToString();
        if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd") return false;

        RECT win;
        if (!GetWindowRect(hWnd, out win)) return false;
        var mon = new MONITORINFO();
        mon.cbSize = (uint)Marshal.SizeOf(mon);
        if (!GetMonitorInfo(MonitorFromWindow(hWnd, 2 /* MONITOR_DEFAULTTONEAREST */), ref mon)) return false;

        return win.Left <= mon.rcMonitor.Left && win.Top <= mon.rcMonitor.Top &&
               win.Right >= mon.rcMonitor.Right && win.Bottom >= mon.rcMonitor.Bottom;
    }
}
'@

# Dedicated browser profile - keeps the kiosk window fully separate from your
# everyday Chrome (a --kiosk flag is otherwise ignored if Chrome is already open).
$ProfileDir = Join-Path $env:LOCALAPPDATA 'ZmanimScreensaver\browser-profile'

function Find-Browser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        # Edge is built into Windows and supports the same kiosk flags, so it's the fallback.
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# The kiosk browser's processes, found by the unique profile folder on their command line.
function Get-KioskProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like "*ZmanimScreensaver*" }
}

function Start-Kiosk($browser) {
    Start-Process -FilePath $browser -ArgumentList @(
        "--kiosk", $Url,
        "--user-data-dir=`"$ProfileDir`"",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",  # closing it by force would otherwise show "Chrome didn't shut down correctly" next time
        "--noerrdialogs",
        # Chrome ignores the old --disable-translate flag now; the translate
        # popup is turned off by the notranslate tags in index.html instead.
        "--disable-features=Translate"
    )
}

function Stop-Kiosk {
    Get-KioskProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($Test) {
    Write-Host "Idle-detection test - move the mouse or type to see the idle time reset. Ctrl+C to stop."
    while ($true) {
        $idle = [math]::Round([ZmanimIdle]::IdleMs() / 1000)
        $fs = [ZmanimIdle]::ForegroundIsFullScreen()
        Write-Host ("Idle: {0,4}s   full-screen app in front: {1}   would open at: {2}s" -f $idle, $fs, ($IdleMinutes * 60))
        Start-Sleep -Seconds 1
    }
}

$browser = Find-Browser
if (-not $browser) {
    Write-Error "Couldn't find Chrome or Edge."
    exit 1
}

Stop-Kiosk  # clean up a kiosk window left over from a previous run (e.g. after a crash)

$showing = $false
$inputTickAtLaunch = 0

while ($true) {
    if (-not $showing) {
        if ([ZmanimIdle]::IdleMs() -ge $IdleMinutes * 60 * 1000 -and -not [ZmanimIdle]::ForegroundIsFullScreen()) {
            Start-Kiosk $browser
            $showing = $true
            $inputTickAtLaunch = [ZmanimIdle]::LastInputTick()
        }
        Start-Sleep -Seconds 5
    } else {
        # Any input at all since the kiosk opened dismisses it.
        if ([ZmanimIdle]::LastInputTick() -ne $inputTickAtLaunch) {
            Stop-Kiosk
            $showing = $false
        }
        Start-Sleep -Milliseconds 250  # short, so dismissing feels instant
    }
}
