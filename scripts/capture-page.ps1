# 用 CDP 的 Page.captureScreenshot 截整个页面（不受窗口遮挡与 DPI 影响）。
# 前提：应用带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
param([string]$Out = "$env:TEMP\highland-note-page.png")

$targets = (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/list" -UseBasicParsing).Content | ConvertFrom-Json
$page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
if (-not $page) { Write-Output "没找到页面"; exit 1 }

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()

function Send-Cdp([string]$json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $buffer = New-Object byte[] 4194304
  $segment = [ArraySegment[byte]]::new($buffer)
  $builder = [Text.StringBuilder]::new()
  do {
    $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).Result
    [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
  } while (-not $result.EndOfMessage)
  return $builder.ToString() | ConvertFrom-Json
}

$reply = Send-Cdp '{"id":1,"method":"Page.captureScreenshot","params":{"format":"png","captureBeyondViewport":false}}'
$ws.Dispose()
$data = $reply.result.data
if (-not $data) { Write-Output "截图失败：$($reply | ConvertTo-Json -Depth 4)"; exit 1 }
[IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($data))
Write-Output "已保存：$Out"
