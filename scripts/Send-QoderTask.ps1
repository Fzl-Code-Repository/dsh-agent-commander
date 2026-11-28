# Send-QoderTask.ps1
# Dispatch a task into the RUNNING Qoder CN desktop GUI (visible in the window, not headless).
#
# Why: `qoderclicn.exe -p` runs headless (print mode) -> nothing appears in the desktop app.
#      This script drives the real GUI: focus window -> Ctrl+N new task -> clipboard paste -> Enter.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File Send-QoderTask.ps1 -Task "帮我看看这个 bug"
#   powershell -NoProfile -ExecutionPolicy Bypass -File Send-QoderTask.ps1 -File task.txt -NoNewTask
#   powershell -NoProfile -ExecutionPolicy Bypass -File Send-QoderTask.ps1 -Task "..." -VerifySeconds 45
#
# Options:
#   -Task <string>        Task text to send (use -File for long text).
#   -File <path>          Read task text from a UTF-8 file instead of -Task.
#   -NoNewTask            Do not press Ctrl+N; send into the currently open conversation.
#   -VerifySeconds <int>  After submitting, wait N seconds then screenshot (0 = skip). Default 20.
#   -ShotDir <path>       Where to write screenshots. Default D:\F-ALL\.probe\qoder-desktop\shots
#   -NoSubmit             Type the text but do not press Enter (dry run / manual review).
#
# Exit codes: 0 = submitted (and screenshot taken), 2 = window not found,
#             3 = window could not be focused, 4 = clipboard/paste failed, 5 = bad args.
#
# Requirements: Qoder CN desktop must already be running. This script never kills it.

[CmdletBinding()]
param(
  [string]$Task = "",
  [string]$File = "",
  [switch]$NoNewTask,
  [int]$VerifySeconds = 20,
  [string]$ShotDir = "D:\F-ALL\.probe\qoder-desktop\shots",
  [switch]$NoSubmit
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QT {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

[void][QT]::SetProcessDPIAware()

function Log([string]$m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

# ---------- 1. resolve task text ----------
if ($File) {
  if (-not (Test-Path -LiteralPath $File)) { Log "ERROR: file not found: $File"; exit 5 }
  $Task = Get-Content -LiteralPath $File -Raw -Encoding UTF8
}
if ([string]::IsNullOrWhiteSpace($Task)) { Log "ERROR: empty task (pass -Task or -File)"; exit 5 }
# Clipboard + Enter: newlines inside the composer are fine (Enter inserts newline there),
# but keep the payload single-block to avoid accidental early submit.
$payload = $Task.TrimEnd()
Log ("task text: {0} chars" -f $payload.Length)

# ---------- 2. find Qoder CN main window ----------
$proc = Get-Process | Where-Object { $_.ProcessName -eq 'Qoder CN' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Log "ERROR: no running 'Qoder CN' window found. Start the app first (this script never starts/kills it)."; exit 2 }
$hwnd = [IntPtr]$proc.MainWindowHandle
Log ("window: hwnd={0} pid={1} title='{2}'" -f $hwnd.ToInt64(), $proc.Id, $proc.MainWindowTitle)

# ---------- 3. bring to foreground ----------
if ([QT]::IsIconic($hwnd)) { [void][QT]::ShowWindow($hwnd, 9) }   # SW_RESTORE
# Tapping ALT releases the Windows foreground lock, otherwise SetForegroundWindow is ignored.
[QT]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[QT]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120

$fg = [QT]::GetForegroundWindow()
$dummy = [uint32]0
$fgThread = [QT]::GetWindowThreadProcessId($fg, [ref]$dummy)
$me = [QT]::GetCurrentThreadId()
if ($fgThread -ne 0 -and $fgThread -ne $me) { [void][QT]::AttachThreadInput($me, $fgThread, $true) }
[void][QT]::BringWindowToTop($hwnd)
[void][QT]::SetForegroundWindow($hwnd)
[void][QT]::SetWindowPos($hwnd, [IntPtr](-1), 0,0,0,0, 0x0003)  # HWND_TOPMOST  + NOSIZE|NOMOVE
[void][QT]::SetWindowPos($hwnd, [IntPtr](-2), 0,0,0,0, 0x0003)  # HWND_NOTOPMOST
if ($fgThread -ne 0 -and $fgThread -ne $me) { [void][QT]::AttachThreadInput($me, $fgThread, $false) }
Start-Sleep -Milliseconds 400

if ([QT]::GetForegroundWindow() -ne $hwnd) {
  Log "ERROR: could not bring Qoder CN to the foreground (another window keeps focus)."
  Log "       Try clicking the Qoder CN window once, then re-run."
  exit 3
}
Log "window focused"

# ---------- 4. open a fresh task (Ctrl+N) ----------
if (-not $NoNewTask) {
  [System.Windows.Forms.SendKeys]::SendWait("^n")
  Start-Sleep -Milliseconds 1600
  Log "sent Ctrl+N (new task); composer has focus - no mouse click needed"
}

# ---------- 5. paste task text ----------
try {
  Set-Clipboard -Value $payload
} catch {
  Log "ERROR: could not set clipboard: $($_.Exception.Message)"
  exit 4
}
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 900
Log ("pasted {0} chars into composer" -f $payload.Length)

# ---------- 6. screenshot the composed text, then submit ----------
if (-not (Test-Path -LiteralPath $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }
function Save-Screen([string]$path) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$shotBefore = Join-Path $ShotDir "typed-$stamp.png"
Save-Screen $shotBefore
Log "screenshot (text typed, not submitted): $shotBefore"

if ($NoSubmit) {
  Log "NoSubmit set - leaving text in the composer. Press Enter yourself when ready."
  exit 0
}

# ---------- 7. submit ----------
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 800
Log "submitted (Enter)"

# ---------- 8. verify ----------
if ($VerifySeconds -gt 0) {
  Log ("waiting {0}s for Qoder to start working..." -f $VerifySeconds)
  Start-Sleep -Seconds $VerifySeconds
  $shotAfter = Join-Path $ShotDir "result-$stamp.png"
  Save-Screen $shotAfter
  Log "screenshot (after submit): $shotAfter"
}

Log "DONE. Open the Qoder CN window - the task is in the conversation list on the left."
exit 0