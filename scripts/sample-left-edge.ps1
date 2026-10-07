# 沿页面左边缘采样像素，找出"左边那条白边"到底是什么、在哪个坐标。
# 只在开发验证时用：配合 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222。
#
#   pwsh -NoProfile -File scripts/sample-left-edge.ps1
Add-Type -AssemblyName System.Drawing

$png = Join-Path $env:TEMP "highland-note-page.png"
if (-not (Test-Path $png)) { Write-Output "先跑 scripts/capture-page.ps1 生成截图"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $png
Write-Output "图片尺寸：$($bmp.Width)x$($bmp.Height)（CSS 视口是 1280 宽，缩放 1.75）"

function Show-Row([int]$y, [int]$from, [int]$to) {
  $prev = ""
  $parts = @()
  for ($x = $from; $x -le $to -and $x -lt $bmp.Width; $x += 1) {
    $c = $bmp.GetPixel($x, $y)
    $hex = "#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B
    if ($hex -ne $prev) {
      $parts += ("x={0} {1}" -f $x, $hex)
      $prev = $hex
    }
  }
  Write-Output ("y={0}: {1}" -f $y, ($parts -join "  "))
}

Write-Output ""
Write-Output "=== 横向颜色变化（左边 0–110 图片像素 ≈ CSS 0–63）==="
Show-Row 400 0 110
Show-Row 900 0 110

Write-Output ""
Write-Output "=== 最左边 0–8 像素，不同高度 ==="
foreach ($y in @(40, 100, 300, 700, 1100, 1400)) { Show-Row $y 0 8 }

Write-Output ""
Write-Output "=== 找最亮的像素列（每列的 R+G+B 平均值）==="
$cols = @()
foreach ($x in 0..20) {
  $sum = 0
  $n = 0
  for ($y = 100; $y -lt $bmp.Height - 100; $y += 20) {
    $c = $bmp.GetPixel($x, $y)
    $sum += $c.R + $c.G + $c.B
    $n += 1
  }
  $cols += [pscustomobject]@{ x = $x; avg = [math]::Round($sum / [math]::Max($n, 1), 1) }
}
$cols | Format-Table -AutoSize
$bmp.Dispose()
