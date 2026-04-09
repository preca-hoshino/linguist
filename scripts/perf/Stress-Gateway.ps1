<#
.SYNOPSIS
  测试模型网关能力的 PowerShell 性能/压测脚本 (高并发终端定制版)
.DESCRIPTION
  此脚本引入了底层的 RunspacePool 实现多线程请求模型。
  支持了类似 Docker Pull 的多行原位进度条刷新 UI 效果。
#>

param (
    [Parameter(Mandatory=$true)]
    [string]$BaseUrl,

    [Parameter(Mandatory=$true)]
    [string]$ApiKey,

    [Parameter(Mandatory=$true)]
    [ValidateSet("openai", "claude", "anthropic", "gemini")]
    [string]$Provider,

    [Parameter(Mandatory=$true)]
    [string]$ModelName,

    [Parameter(Mandatory=$true)]
    [ValidateSet("chat", "embedding", "both")]
    [string]$ModelType,

    [Parameter(Mandatory=$true)]
    [int]$Count,
    
    [int]$Concurrency = 40,

    [switch]$DisableChatStream,
    [switch]$DisableChatHistory,
    [int]$DelaySeconds = 1,
    [switch]$RandomizeThink,
    [string]$ThinkingMode = "auto",
    [string]$ReasoningEffort = "medium"
)

$ChatStream = -not $DisableChatStream
$EnableChatHistory = -not $DisableChatHistory
$MaxHistoryTurns = 5

$PromptsFile = Join-Path $PSScriptRoot "prompts.json"
if (-not (Test-Path $PromptsFile)) {
    $PromptsFile = Join-Path (Split-Path $PSScriptRoot -Parent) "prompts.json"
    if (-not (Test-Path $PromptsFile)) {
        $PromptsFile = "prompts.json"
    }
}

if (-not (Test-Path $PromptsFile)) {
    Write-Host "错误: 找不到语料配置文件 prompts.json!" -ForegroundColor Red
    exit 1
}

$PromptsData = Get-Content -Raw -Encoding UTF8 $PromptsFile | ConvertFrom-Json

# =========================================================================
# 共享状态与数据大盘 (并发线程安全)
# =========================================================================

$SharedHistory = [System.Collections.Concurrent.ConcurrentBag[PSCustomObject]]::new()
$SharedState = [System.Collections.Concurrent.ConcurrentDictionary[int, string]]::new()
$SharedStats = [System.Collections.Concurrent.ConcurrentDictionary[string, int]]::new()

$SharedStats["Success"] = 0
$SharedStats["Fail"] = 0
$SharedStats["TotalDone"] = 0

for ($i = 0; $i -lt $Concurrency; $i++) {
    $SharedState[$i] = "🟢 空闲"
}

# =========================================================================
# 多线程 Worker 引擎 (在隔离的 Runspace 中无限复用)
# =========================================================================

$WorkerScript = {
    param($ArgsConfig)

    # 突破 .NET 默认的并发连接数限制 (默认仅为 2) 
    # 这是导致高并发压测时本地抛出 GetResponse 异常而服务端无感知的根本原因
    [System.Net.ServicePointManager]::DefaultConnectionLimit = 10000
    [System.Net.ServicePointManager]::Expect100Continue = $false

    $TaskOffset = $ArgsConfig.TaskOffset
    $SlotId     = $ArgsConfig.SlotId
    $Config     = $ArgsConfig.Config
    $State      = $ArgsConfig.State
    $Stats      = $ArgsConfig.Stats
    $History    = $ArgsConfig.History

    function Set-State([string]$text) {
        $State[$SlotId] = "[Task $($TaskOffset.ToString('000'))] $text"
    }

    function Get-RandomArrayItem($Arr) {
        if ($Arr -eq $null -or $Arr.Count -eq 0) { return $null }
        $idx = Get-Random -Minimum 0 -Maximum $Arr.Count
        return $Arr[$idx]
    }

    try {
        $sysPrompt = Get-RandomArrayItem $Config.SystemPrompts
        $chatPrompt = Get-RandomArrayItem $Config.ChatPrompts

        # 组装上下文消息
        $messages = @()
        $messages += @{ role = "system"; content = $sysPrompt }

        if ($Config.EnableChatHistory) {
            $snap = $History.ToArray()
            if ($snap.Count -gt 0) {
                $maxLimit = [Math]::Min($Config.MaxHistoryTurns, $snap.Count)
                $historyCount = Get-Random -Minimum 1 -Maximum ($maxLimit + 1)
                $picked = $snap | Get-Random -Count $historyCount
                if ($null -ne $picked) {
                    foreach ($h in @($picked)) {
                        if ($h) {
                            $messages += @{ role = "user"; content = $h.User }
                            $messages += @{ role = "assistant"; content = $h.Assistant }
                        }
                    }
                }
            }
        }
        $messages += @{ role = "user"; content = $chatPrompt }

        $enableChat = ($Config.ModelType -eq "chat" -or $Config.ModelType -eq "both")
        $enableEmbed = ($Config.ModelType -eq "embedding" -or $Config.ModelType -eq "both")

        # Claude API 不支持单独 /embeddings 路径接口（或本架构已屏蔽）
        if ($Config.Provider -eq "claude" -or $Config.Provider -eq "anthropic") {
            $enableEmbed = $false
        }

        # ======== 执行 CHAT ========
        if ($enableChat) {
            $body = @{
                model    = $Config.ModelName
                stream   = $Config.ChatStream
                messages = $messages
            }

            # 各大模型专属思考策略 (Reasoning Effort / Thinking Budget)
            if ($Config.Provider -eq "openai") {
                if ($Config.RandomizeThink) {
                    $efforts = @($null, "minimal", "low", "medium", "high")
                    $eff = Get-RandomArrayItem $efforts
                    if ($null -ne $eff) { $body["reasoning_effort"] = $eff }
                } elseif ($Config.ThinkingMode -ne "disabled") {
                    $body["reasoning_effort"] = $Config.ReasoningEffort
                }
            } elseif ($Config.Provider -eq "claude" -or $Config.Provider -eq "anthropic") {
                $doThink = $false
                if ($Config.RandomizeThink) { $doThink = ((Get-Random -Minimum 0 -Maximum 2) -eq 1) }
                else { $doThink = ($Config.ThinkingMode -eq "auto" -or $Config.ThinkingMode -eq "enabled") }
                if ($doThink) { $body["thinking"] = @{ type = "enabled"; budget_tokens = 2048 } }
            } elseif ($Config.Provider -eq "gemini") {
                $doThink = $false
                if ($Config.RandomizeThink) { $doThink = ((Get-Random -Minimum 0 -Maximum 2) -eq 1) }
                else { $doThink = ($Config.ThinkingMode -eq "auto" -or $Config.ThinkingMode -eq "enabled") }
                if ($doThink) { $body["thinking"] = @{ type = "enabled" } }
            }

            Set-State "🟡 等待 Chat 首流..."
            $reqBytes = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))
            $chatStart = Get-Date

            if ($Config.ChatStream -eq $true) {
                # [流式处理引擎] 实时截获网络数据包
                $request = [System.Net.HttpWebRequest]::Create("$($Config.BaseUrl)/chat/completions")
                $request.Method = "POST"
                $request.Headers.Add("Authorization", "Bearer $($Config.ApiKey)")
                $request.ContentType = "application/json; charset=utf-8"
                $request.KeepAlive = $false
                $request.Timeout = 120000
                
                $reqStream = $request.GetRequestStream()
                $reqStream.Write($reqBytes, 0, $reqBytes.Length)
                $reqStream.Close()

                $response = $request.GetResponse()
                $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)

                $replyAccumulator = ""
                $ttft = 0

                while (($line = $reader.ReadLine()) -ne $null) {
                    if ($line.StartsWith("data: ")) {
                        $dataStr = $line.Substring(6)
                        if ($dataStr -eq "[DONE]") { break }
                        try {
                            $json = $dataStr | ConvertFrom-Json
                            $token = $json.choices[0].delta.content
                            $thinkToken = $json.choices[0].delta.reasoning_content

                            if ($ttft -eq 0 -and (-not [string]::IsNullOrEmpty($token) -or -not [string]::IsNullOrEmpty($thinkToken))) {
                                $ttft = ((Get-Date) - $chatStart).TotalMilliseconds
                            }

                            if (-not [string]::IsNullOrEmpty($token)) {
                                $replyAccumulator += $token
                            }

                            # 同步热更新耗时状态
                            $currTime = ((Get-Date) - $chatStart).TotalMilliseconds
                            if ($ttft -ne 0) {
                                Set-State "🔵 正在回复 (距首字 $([math]::Round($currTime - $ttft))ms)..."
                            }
                        } catch {}
                    }
                }
                $reader.Close(); $response.Close()

                if (-not [string]::IsNullOrEmpty($replyAccumulator)) {
                    $History.Add([PSCustomObject]@{ User = $chatPrompt; Assistant = $replyAccumulator })
                }
                $totalTime = ((Get-Date) - $chatStart).TotalMilliseconds
                $Stats.AddOrUpdate("Success", 1, { param($k, $v) $v + 1 }) | Out-Null
                Set-State "🟢 已完成 (TTFT: $([math]::Round($ttft))ms / 总: $([math]::Round($totalTime))ms)"

            } else {
                # [阻塞式处理引擎]
                $Headers = @{ "Authorization" = "Bearer $($Config.ApiKey)" }
                $resp = Invoke-RestMethod -Uri "$($Config.BaseUrl)/chat/completions" -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $reqBytes -ErrorAction Stop
                $replyAccumulator = $resp.choices[0].message.content
                if (-not [string]::IsNullOrEmpty($replyAccumulator)) {
                    $History.Add([PSCustomObject]@{ User = $chatPrompt; Assistant = $replyAccumulator })
                }
                
                $totalTime = ((Get-Date) - $chatStart).TotalMilliseconds
                $Stats.AddOrUpdate("Success", 1, { param($k, $v) $v + 1 }) | Out-Null
                Set-State "🟢 已完成 (总: $([math]::Round($totalTime))ms)"
            }
        }

        # ======== 执行 EMBED ========
        if ($enableEmbed) {
            Set-State "🟡 等待 Embed 响应..."
            $em_prompt = Get-RandomArrayItem $Config.ChatPrompts
            $em_reqBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ model = $Config.ModelName; input = $em_prompt } | ConvertTo-Json -Depth 5 -Compress))
            $emStart = Get-Date

            $Headers = @{ "Authorization" = "Bearer $($Config.ApiKey)" }
            $resp = Invoke-RestMethod -Uri "$($Config.BaseUrl)/embeddings" -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $em_reqBytes -ErrorAction Stop
            
            $Stats.AddOrUpdate("Success", 1, { param($k, $v) $v + 1 }) | Out-Null
            $totalTime = ((Get-Date) - $emStart).TotalMilliseconds
            Set-State "🟢 Embed 完成 (耗时: $([math]::Round($totalTime))ms)"
        }

        # 如果队列仍有后续，并且请求了强制阻塞间歇延迟
        if ($Config.DelaySeconds -gt 0) {
            Start-Sleep -Seconds $Config.DelaySeconds
        }

    } catch {
        $Stats.AddOrUpdate("Fail", 1, { param($k, $v) $v + 1 }) | Out-Null
        $errMsg = $_.Exception.Message
        if ($_.Exception.InnerException -and $_.Exception.InnerException.Response) {
            try {
                $errStream = $_.Exception.InnerException.Response.GetResponseStream()
                $errReader = New-Object System.IO.StreamReader($errStream, [System.Text.Encoding]::UTF8)
                $errMsg = $errReader.ReadToEnd()
                $errReader.Close()
            } catch {}
        }
        $errMsgClean = $errMsg -replace "`r", "" -replace "`n", ""
        if ($errMsgClean.Length -gt 35) { $errMsgClean = $errMsgClean.Substring(0, 35) + "..." }
        Set-State "🔴 异常 ($errMsgClean)"
    } finally {
        $Stats.AddOrUpdate("TotalDone", 1, { param($k, $v) $v + 1 }) | Out-Null
    }
}

# =========================================================================
# 调度与编排大盘 (UI Render Thread)
# =========================================================================

$ConfigObj = @{
    BaseUrl           = $BaseUrl
    ApiKey            = $ApiKey
    Provider          = $Provider
    ModelName         = $ModelName
    ModelType         = $ModelType
    ChatStream        = $ChatStream
    EnableChatHistory = $EnableChatHistory
    MaxHistoryTurns   = $MaxHistoryTurns
    RandomizeThink    = $RandomizeThink
    ThinkingMode      = $ThinkingMode
    ReasoningEffort   = $ReasoningEffort
    DelaySeconds      = $DelaySeconds
    SystemPrompts     = @($SystemPrompts)
    ChatPrompts       = @($ChatPrompts)
}

Clear-Host
Write-Host "================ 测试概览 (并发支持) ================" -ForegroundColor Cyan
Write-Host "网关地址: `t $BaseUrl"
Write-Host "服务目标: `t $Provider"
Write-Host "所测模型: `t $ModelName ($ModelType)"
Write-Host "流式输出: `t $ChatStream | 动态历史: $EnableChatHistory"
Write-Host "任务总数: `t $Count 组"
Write-Host "并发级别: `t $Concurrency 线程并驾齐驱"
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "`n"

$Pool = [runspacefactory]::CreateRunspacePool(1, $Concurrency)
$Pool.Open()

$Queue = [System.Collections.Generic.Queue[int]]::new()
for ($i = 1; $i -le $Count; $i++) { $Queue.Enqueue($i) }

$ActiveRuns = @{}

# 获取初始光标以便在上方留出空白，在下方覆盖刷新
$StartY = 0
$IsConsoleInteractive = $true
try {
    $StartY = [Console]::CursorTop
    $NeededLines = $Concurrency + 5
    if ($StartY + $NeededLines -ge [Console]::BufferHeight) {
        # 强制上边界适配
        $StartY = [Math]::Max(0, [Console]::BufferHeight - $NeededLines - 1)
    }
    [Console]::CursorVisible = $false
} catch {
    $IsConsoleInteractive = $false
}
try {
    # 主事件渲染循环：不断投递分发、并渲染终端 UI (类 Docker Pull)
    while ($Queue.Count -gt 0 -or $ActiveRuns.Count -gt 0) {
        
        # 释放资源并抓取空闲 Slot 回填
        $freeSlots = @(0..($Concurrency - 1)) | Where-Object { -not $ActiveRuns.ContainsKey($_) }
        foreach ($slot in $freeSlots) {
            if ($Queue.Count -gt 0) {
                $taskId = $Queue.Dequeue()
                
                $ArgsConfig = @{
                    TaskOffset = $taskId
                    SlotId     = $slot
                    Config     = $ConfigObj
                    State      = $SharedState
                    Stats      = $SharedStats
                    History    = $SharedHistory
                }
                
                $SharedState[$slot] = "[Task $($taskId.ToString('000'))] ⚪ 排队挂载中..."
                $ps = [powershell]::Create().AddScript($WorkerScript).AddArgument($ArgsConfig)
                $ps.RunspacePool = $Pool
                $handle = $ps.BeginInvoke()
                $ActiveRuns[$slot] = @{ PS = $ps; Handle = $handle }
            }
        }
        
        # 卸载已被完毕消化的 Slots
        foreach ($slot in @($ActiveRuns.Keys)) {
            $run = $ActiveRuns[$slot]
            if ($run.Handle.IsCompleted) {
                try {
                    $run.PS.EndInvoke($run.Handle)
                } catch {
                    $SharedState[$slot] = "🔴 运行时崩溃: $($_.Exception.Message)"
                }
                $run.PS.Dispose()
                $ActiveRuns.Remove($slot)
            }
        }
        
        # 终端进度渲染计算
        # 尝试静默捕获由于由于调整窗口导致的操作越界错
        try {
            [Console]::SetCursorPosition(0, $StartY)
        } catch { }
        
        $totalDone = $SharedStats["TotalDone"]
        $success = $SharedStats["Success"]
        $fail = $SharedStats["Fail"]
        
        $percent = 0
        if ($Count -gt 0) { $percent = [math]::Round(($totalDone / $Count) * 100) }
        
        $barWidth = 40
        $filled = [math]::Round(($percent / 100) * $barWidth)
        $empty = $barWidth - $filled
        $bar = ("#" * $filled) + ("-" * $empty)
        
        Write-Host "全局进度: [$bar] $percent% ($totalDone / $Count)        " -ForegroundColor Yellow
        Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
        
        for ($i = 0; $i -lt $Concurrency; $i++) {
            $stateText = $SharedState[$i]
            # 抹除右侧上帧残影，将文本严格靠左补齐对齐
            if ($stateText.Length -lt 70) { 
                $stateText = $stateText.PadRight(70) 
            } elseif ($stateText.Length -gt 70) { 
                $stateText = $stateText.Substring(0, 67) + "..." 
            }
            Write-Host "并发执行槽位 [Slot $(($i + 1).ToString('00'))]: $stateText"
        }
        
        Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
        Write-Host "  ✅ 成功接收: $success    |    ❌ 异常中断: $fail               "
        
        # 帧率 (10 FPS 每秒自刷新 10 次)
        Start-Sleep -Milliseconds 100
    }
} finally {
    try { [Console]::CursorVisible = $true } catch {}
    $Pool.Close()
    $Pool.Dispose()
}

Write-Host "`n============== 压测发包完毕 ==============" -ForegroundColor Cyan
