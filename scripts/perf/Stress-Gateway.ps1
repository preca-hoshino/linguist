<#
.SYNOPSIS
  测试模型网关能力的 PowerShell 性能/压测脚本
.DESCRIPTION
  此脚本用于批量向网关发送对话聊天 (Chat) 和文本嵌入 (Embeddings) 请求。
  已剥离内部硬编码设定，全部依赖参数输入。
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

$GlobalHistory = [System.Collections.Generic.List[PSCustomObject]]::new()

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
$SystemPrompts = $PromptsData.SystemPrompts
$ChatPrompts = $PromptsData.ChatPrompts

$script:successCount = 0
$script:failCount = 0
$script:totalReqs = 0

# =========================================================================
# 核心通信模块
# =========================================================================

function Invoke-GatewayChat {
    param (
        [System.Collections.Hashtable]$Body,
        [string]$sysPrompt,
        [string]$userPrompt,
        [int]$historyTurnsAdded
    )

    $reqBytes = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 5 -Compress))
    $chatStart = Get-Date
    $ttft = 0; $reply = ""; $errMsg = $null; $success = $false

    Write-Host "----------------------------------" -ForegroundColor DarkGray
    if ($historyTurnsAdded -gt 0) { Write-Host "[!] 已带入历史上下文：$historyTurnsAdded 轮" -ForegroundColor Cyan }
    Write-Host "[System] $sysPrompt" -ForegroundColor DarkCyan
    Write-Host "[User] $userPrompt`n" -ForegroundColor Magenta

    try {
        if ($Body.stream -eq $true) {
            $request = [System.Net.HttpWebRequest]::Create("$BaseUrl/chat/completions")
            $request.Method = "POST"
            $request.Headers.Add("Authorization", "Bearer $ApiKey")
            $request.ContentType = "application/json; charset=utf-8"
            $reqStream = $request.GetRequestStream()
            $reqStream.Write($reqBytes, 0, $reqBytes.Length)
            $reqStream.Close()

            $response = $request.GetResponse()
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)

            $thinkingBuf = ""; $replyBuf = ""; $inThinking = $false; $thinkPrinted = $false

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

                        if (-not [string]::IsNullOrEmpty($thinkToken)) {
                            if (-not $inThinking) { Write-Host "[Thinking]" -ForegroundColor DarkYellow; $inThinking = $true }
                            Write-Host $thinkToken -NoNewline -ForegroundColor DarkGray
                            $thinkingBuf += $thinkToken
                        }

                        if (-not [string]::IsNullOrEmpty($token)) {
                            if ($inThinking -and -not $thinkPrinted) { Write-Host "`n[Reply]" -ForegroundColor Green; $thinkPrinted = $true }
                            elseif (-not $inThinking -and -not $thinkPrinted) { Write-Host "[Reply]" -ForegroundColor Green; $thinkPrinted = $true }
                            Write-Host $token -NoNewline -ForegroundColor White
                            $replyBuf += $token
                        }
                    } catch {}
                }
            }
            $reader.Close(); $response.Close()
            Write-Host "`n"
            $reply = $replyBuf; $success = $true
        } else {
            $Headers = @{ "Authorization" = "Bearer $ApiKey" }
            $resp = Invoke-RestMethod -Uri "$BaseUrl/chat/completions" -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $reqBytes -ErrorAction Stop
            
            $msgContent = $resp.choices[0].message.content
            $msgThink   = $resp.choices[0].message.reasoning_content

            if (-not [string]::IsNullOrEmpty($msgThink)) {
                Write-Host "[Thinking]" -ForegroundColor DarkYellow
                Write-Host $msgThink -ForegroundColor DarkGray
                Write-Host ""
            }
            Write-Host "[Reply]" -ForegroundColor Green
            Write-Host $msgContent -ForegroundColor White

            $reply = $msgContent; $success = $true; $ttft = 0
        }
    } catch {
        $webEx = $_.Exception.InnerException
        if ($null -ne $webEx -and $null -ne $webEx.Response) {
            try {
                $errStream = $webEx.Response.GetResponseStream()
                $errReader = New-Object System.IO.StreamReader($errStream, [System.Text.Encoding]::UTF8)
                $errBody   = $errReader.ReadToEnd()
                $errReader.Close()
                $errJson = $errBody | ConvertFrom-Json -ErrorAction SilentlyContinue
                $errMsg  = if ($errJson.error.message) { "[HTTP $($webEx.Response.StatusCode)] $($errJson.error.message)" } else { "[HTTP $($webEx.Response.StatusCode)] $errBody" }
            } catch { $errMsg = $_.Exception.Message }
        } else { $errMsg = $_.Exception.Message }
    }

    if ($success) {
        $GlobalHistory.Add([PSCustomObject]@{ User = $userPrompt; Assistant = $reply })
        $replyClean = $reply -replace "`r", "" -replace "`n", " "
        if ($replyClean.Length -gt 60) { $replyClean = $replyClean.Substring(0, 60) + "..." }
        $msg = "  [完成] 总耗时: $([math]::Round(((Get-Date) - $chatStart).TotalMilliseconds))ms"
        if ($Body.stream -eq $true) { $msg += " | 首字延迟(TTFT): $([math]::Round($ttft))ms" }
        Write-Host "$msg | 摘要: $replyClean" -ForegroundColor DarkGreen
        $script:successCount++
    } else {
        Write-Host "  [请求失败] $errMsg" -ForegroundColor Red
        $script:failCount++
    }
}

function Invoke-GatewayEmbed {
    param (
        [string]$Model,
        [string]$InputText
    )
    $reqBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ model = $Model; input = $InputText } | ConvertTo-Json -Depth 5 -Compress))
    Write-Host "`n  [Embed] 文本 : $InputText" -ForegroundColor Magenta
    $embedStart = Get-Date

    try {
        $Headers = @{ "Authorization" = "Bearer $ApiKey" }
        $resp = Invoke-RestMethod -Uri "$BaseUrl/embeddings" -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $reqBytes -ErrorAction Stop
        Write-Host "  [完成] 耗时: $([math]::Round(((Get-Date) - $embedStart).TotalMilliseconds))ms | 维度: $($resp.data[0].embedding.Count) | Tokens: $($resp.usage.total_tokens)" -ForegroundColor DarkGreen
        $script:successCount++
    } catch {
        $ex = $_.Exception
        if ($null -ne $ex -and $null -ne $ex.Response) {
            try {
                $errStream = $ex.Response.GetResponseStream()
                $errReader = New-Object System.IO.StreamReader($errStream, [System.Text.Encoding]::UTF8)
                $errBody   = $errReader.ReadToEnd()
                $errReader.Close()
                $errJson = $errBody | ConvertFrom-Json -ErrorAction SilentlyContinue
                $errMsg  = if ($errJson.error.message) { "[HTTP $($ex.Response.StatusCode)] $($errJson.error.message)" } else { "[HTTP $($ex.Response.StatusCode)] $errBody" }
            } catch {
                $errMsg = $ex.Message
            }
        } else {
            $errMsg = $ex.Message
        }
        Write-Host "  [请求失败] $errMsg" -ForegroundColor Red
        $script:failCount++
    }
}

# =========================================================================
# 三家服务商实现
# =========================================================================

function Get-TestMessages {
    $sysPrompt = $SystemPrompts | Get-Random
    $prompt = $ChatPrompts | Get-Random
    
    $messages = @()
    $messages += @{ role = "system"; content = $sysPrompt }
    
    $historyCountAdded = 0
    if ($EnableChatHistory -and ($GlobalHistory.Count -gt 0)) {
        $poolSize = $GlobalHistory.Count
        $maxLimit = [Math]::Min($MaxHistoryTurns, $poolSize)
        $historyCount = Get-Random -Minimum 1 -Maximum ($maxLimit + 1)
        
        $selectedPairs = $GlobalHistory | Get-Random -Count $historyCount
        foreach ($h in @($selectedPairs)) {
            if ($null -ne $h) {
                $messages += @{ role = "user"; content = $h.User }
                $messages += @{ role = "assistant"; content = $h.Assistant } 
                $historyCountAdded++
            }
        }
    }
    $messages += @{ role = "user"; content = $prompt }
    return @{ sys = $sysPrompt; user = $prompt; messages = $messages; historyCount = $historyCountAdded }
}

function Test-ProviderOpenAI {
    $enableChat = ($ModelType -eq "chat" -or $ModelType -eq "both")
    $enableEmbed = ($ModelType -eq "embedding" -or $ModelType -eq "both")

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host ">>> 执行目标: OpenAI API" -ForegroundColor Cyan
    Write-Host "    应用模型: $ModelName | 类型: $ModelType" -ForegroundColor DarkCyan
    Write-Host "==========================================" -ForegroundColor Cyan

    for ($round = 1; $round -le $Count; $round++) {
        Write-Host "`n> [OpenAI - 轮次 $round]" -ForegroundColor Yellow
        
        if ($enableChat) {
            $msgData = Get-TestMessages
            $body = @{
                model    = $ModelName
                stream   = $ChatStream
                messages = $msgData.messages
            }
            
            if ($RandomizeThink) {
                $effort = @($null, "minimal", "low", "medium", "high") | Get-Random
                if ($null -ne $effort) { 
                    $body["reasoning_effort"] = $effort
                    Write-Host "[!] OpenAI 策略: reasoning_effort=$effort" -ForegroundColor Yellow 
                }
            } else {
                if ($ThinkingMode -ne "disabled") {
                    $body["reasoning_effort"] = $ReasoningEffort
                    Write-Host "[!] OpenAI 策略: reasoning_effort=$ReasoningEffort" -ForegroundColor Yellow
                }
            }

            $script:totalReqs++
            Invoke-GatewayChat -Body $body -sysPrompt $msgData.sys -userPrompt $msgData.user -historyTurnsAdded $msgData.historyCount
        }
        
        if ($enableEmbed) {
            $script:totalReqs++
            $embedPrompt = $ChatPrompts | Get-Random
            Invoke-GatewayEmbed -Model $ModelName -InputText $embedPrompt
        }

        if ($round -lt $Count) { Start-Sleep -Seconds $DelaySeconds }
    }
}

function Test-ProviderClaude {
    $enableChat = ($ModelType -eq "chat" -or $ModelType -eq "both")
    $enableEmbed = $false # 强制禁用嵌入 "选择claude就把嵌入排掉"

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host ">>> 执行目标: Anthropic Claude API" -ForegroundColor Cyan
    if ($ModelType -eq "both" -or $ModelType -eq "embedding") {
        Write-Host "    应用模型: $ModelName | 类型: $ModelType (⚠️已为您强制排掉嵌入验证)" -ForegroundColor DarkCyan
    } else {
        Write-Host "    应用模型: $ModelName | 类型: $ModelType" -ForegroundColor DarkCyan
    }
    Write-Host "==========================================" -ForegroundColor Cyan

    for ($round = 1; $round -le $Count; $round++) {
        Write-Host "`n> [Claude - 轮次 $round]" -ForegroundColor Yellow
        
        if ($enableChat) {
            $msgData = Get-TestMessages
            $body = @{
                model    = $ModelName
                stream   = $ChatStream
                messages = $msgData.messages
            }
            
            $enableThinking = $false
            if ($RandomizeThink) {
                $enableThinking = (Get-Random -Minimum 0 -Maximum 2) -eq 1
            } else {
                $enableThinking = ($ThinkingMode -eq "auto" -or $ThinkingMode -eq "enabled")
            }

            if ($enableThinking) {
                $body["thinking"] = @{ type = "enabled"; budget_tokens = 2048 }
                Write-Host "[!] Claude 策略: 启用扩展思考 (budget_tokens: 2048)" -ForegroundColor Yellow
            }

            $script:totalReqs++
            Invoke-GatewayChat -Body $body -sysPrompt $msgData.sys -userPrompt $msgData.user -historyTurnsAdded $msgData.historyCount
        }
        
        if ($round -lt $Count) { Start-Sleep -Seconds $DelaySeconds }
    }
}

function Test-ProviderGemini {
    $enableChat = ($ModelType -eq "chat" -or $ModelType -eq "both")
    $enableEmbed = ($ModelType -eq "embedding" -or $ModelType -eq "both")

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host ">>> 执行目标: Google Gemini API" -ForegroundColor Cyan
    Write-Host "    应用模型: $ModelName | 类型: $ModelType" -ForegroundColor DarkCyan
    Write-Host "==========================================" -ForegroundColor Cyan

    for ($round = 1; $round -le $Count; $round++) {
        Write-Host "`n> [Gemini - 轮次 $round]" -ForegroundColor Yellow
        
        if ($enableChat) {
            $msgData = Get-TestMessages
            $body = @{
                model    = $ModelName
                stream   = $ChatStream
                messages = $msgData.messages
            }
            
            $enableThinking = $false
            if ($RandomizeThink) {
                $enableThinking = (Get-Random -Minimum 0 -Maximum 2) -eq 1
            } else {
                $enableThinking = ($ThinkingMode -eq "auto" -or $ThinkingMode -eq "enabled")
            }

            if ($enableThinking) {
                $body["thinking"] = @{ type = "enabled" }
                Write-Host "[!] Gemini 策略: 启用标准思考" -ForegroundColor Yellow
            }

            $script:totalReqs++
            Invoke-GatewayChat -Body $body -sysPrompt $msgData.sys -userPrompt $msgData.user -historyTurnsAdded $msgData.historyCount
        }
        
        if ($enableEmbed) {
            $script:totalReqs++
            $embedPrompt = $ChatPrompts | Get-Random
            Invoke-GatewayEmbed -Model $ModelName -InputText $embedPrompt
        }

        if ($round -lt $Count) { Start-Sleep -Seconds $DelaySeconds }
    }
}

# =========================================================================
# 执行引擎入口
# =========================================================================

Write-Host "================ 测试概览 ================" -ForegroundColor Cyan
Write-Host "网关地址: `t $BaseUrl"
Write-Host "服务目标: `t $Provider"
Write-Host "所测模型: `t $ModelName ($ModelType)"
Write-Host "流式输出: `t $ChatStream"
Write-Host "动态历史: `t $EnableChatHistory"
Write-Host "任务总数: `t $Count 组"
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "`n语料初始化完成: $($ChatPrompts.Count) 组对话样例." -ForegroundColor Green

if ($Provider -eq "openai") {
    Test-ProviderOpenAI
} elseif ($Provider -eq "claude" -or $Provider -eq "anthropic") {
    Test-ProviderClaude
} elseif ($Provider -eq "gemini") {
    Test-ProviderGemini
}

Write-Host "`n============== 性能测试最终报表 ==============" -ForegroundColor Cyan
Write-Host "总请求数: $script:totalReqs"
Write-Host "成功数: $script:successCount" -ForegroundColor Green
if ($script:failCount -gt 0) { Write-Host "失败数: $script:failCount" -ForegroundColor Red } else { Write-Host "失败数: 0" -ForegroundColor Green }
Write-Host "==========================================" -ForegroundColor Cyan
