# 通过 WebView2 的远程调试端口在页面里执行一段 JS，把结果打印出来。
# 只在开发验证时用（应用要用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动）。
#
#   pwsh -NoProfile -File scripts/eval-in-app.ps1 -Expression "1+1"
param([Parameter(Mandatory = $true)][string]$Expression)

$targets = (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/list" -UseBasicParsing).Content | ConvertFrom-Json
$page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
if (-not $page) { Write-Output "没找到页面"; exit 1 }

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$uri = [Uri]$page.webSocketDebuggerUrl
$ws.ConnectAsync($uri, [Threading.CancellationToken]::None).Wait()

$payload = @{
  id     = 1
  method = "Runtime.evaluate"
  params = @{
    expression            = $Expression
    returnByValue         = $true
    awaitPromise          = $true
    userGesture           = $true
  }
} | ConvertTo-Json -Depth 8 -Compress

$bytes = [Text.Encoding]::UTF8.GetBytes($payload)
$ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()

$buffer = New-Object byte[] 262144
$segment = [ArraySegment[byte]]::new($buffer)
$builder = [Text.StringBuilder]::new()
do {
  $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).Result
  [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
} while (-not $result.EndOfMessage)
$ws.Dispose()

$reply = $builder.ToString() | ConvertFrom-Json
if ($reply.result.exceptionDetails) {
  Write-Output "JS 异常：$($reply.result.exceptionDetails.text)"
  Write-Output ($reply.result.exceptionDetails.exception.description)
  exit 1
}
$value = $reply.result.result.value
if ($null -eq $value) { Write-Output ($reply.result.result | ConvertTo-Json -Depth 6) }
else { Write-Output ($value | ConvertTo-Json -Depth 6) }
