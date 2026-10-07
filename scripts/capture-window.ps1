# 把运行中的 highland_note 窗口截图到临时文件，用于验证界面。
# 只在开发验证时用，不属于应用代码。
#
# 踩过的坑，别再踩：
# 1. 用 CopyFromScreen 抓屏会受窗口遮挡与 DPI 缩放影响（这台机器缩放开 175%，抓出来只有左半截）；
#    改用它自己的 PrintWindow —— 窗口把自己画进我给的内存 DC，遮挡与缩放都不影响。
# 2. SetWindowPos 带 SWP_NOSIZE 传 0 尺寸会把窗口缩成 14x14，别那么干。
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process highland_note -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "没有找到 highland_note 窗口"; exit 1 }

$handle = $proc.MainWindowHandle
[Win]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
[Win]::BringWindowToTop($handle) | Out-Null
[Win]::SetForegroundWindow($handle) | Out-Null

$front = $false
for ($i = 0; $i -lt 20; $i += 1) {
  Start-Sleep -Milliseconds 250
  if ([Win]::GetForegroundWindow() -eq $handle) { $front = $true; break }
}
Start-Sleep -Milliseconds 700

$rect = New-Object Win+RECT
[Win]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 200 -or $height -lt 200) {
  Write-Output "窗口矩形不合理（${width}x${height}），先修窗口大小再截图"
  exit 1
}

# PrintWindow 让窗口把自己画进来：不受遮挡、不受 DPI 缩放影响
$bmp = New-Object System.Drawing.Bitmap $width, $height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
$ok = [Win]::PrintWindow($handle, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT（WebView2 需要这个）
$gfx.ReleaseHdc($hdc)
if (-not $ok) {
  # 退一步：整块屏幕里按窗口矩形截，至少还能看
  $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  Write-Output "PrintWindow 返回失败，已退回抓屏"
}
$out = Join-Path $env:TEMP "highland-note-shot.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output "窗口：$($rect.Left),$($rect.Top) ${width}x${height} 前台=$front → $out"
