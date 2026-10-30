<#
.SYNOPSIS
  Smoke-tests the Nevis local MCP connection from Windows PowerShell 5.1+ (no Node needed).

.DESCRIPTION
  1. In Nevis: Settings > Agent connections > Enable connection > Copy connection details.
  2. Run this script. It reads the copied JSON from the clipboard (or -ConfigPath).

  Read-only checks run by default. -Write also creates a throw-away page, edits it,
  reads it back, undoes the edit and renames it (needs "Allow document editing" enabled).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\test-mcp.ps1
  powershell -ExecutionPolicy Bypass -File tools\test-mcp.ps1 -Write
#>
param(
  [string]$ConfigPath,
  [switch]$Write
)
$ErrorActionPreference = 'Stop'

$raw = if ($ConfigPath) { Get-Content -Raw -Encoding UTF8 $ConfigPath } else { Get-Clipboard -Raw }
try { $cfg = $raw | ConvertFrom-Json; if (-not $cfg.url) { throw 'no url' } }
catch {
  Write-Host 'The clipboard does not hold the connection details copied from Nevis.' -ForegroundColor Yellow
  Write-Host 'In Nevis: Settings > Agent connections > Enable connection > Copy connection details.' -ForegroundColor Yellow
  Write-Host 'Or type them here:'
  $u = Read-Host 'url   (http://127.0.0.1:<port>/mcp)'
  $t = Read-Host 'token (the part after "Bearer ")'
  $cfg = [pscustomobject]@{ url = $u.Trim(); headers = [pscustomobject]@{ Authorization = "Bearer $($t.Trim())" } }
}
$url = $cfg.url
$token = $cfg.headers.Authorization -replace '^Bearer\s+', ''
if (-not $url -or -not $token) { throw 'Missing url or Authorization header in the connection details.' }
if ($url -notmatch '^http://127\.0\.0\.1:\d+/mcp$') { throw "Unexpected url: $url" }

$script:pass = 0; $script:fail = 0
function Check($name, $ok, $detail) {
  if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  FAIL  $name  $detail" -ForegroundColor Red }
}

# Raw HTTP POST; returns status, headers and the UTF-8 decoded body (never throws on HTTP errors).
function Send($body, $headers) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  try {
    $r = Invoke-WebRequest -Uri $url -Method Post -Body $bytes -Headers $headers -UseBasicParsing -TimeoutSec 40
  } catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if (-not $r) { throw "Cannot reach $url. Is Nevis open with the connection enabled? Copy fresh details (port and token change on every enable)." }
    $reader = New-Object IO.StreamReader($r.GetResponseStream(), [Text.Encoding]::UTF8)
    return @{ Status = [int]$r.StatusCode; Headers = $r.Headers; Body = $reader.ReadToEnd() }
  }
  $ms = New-Object IO.MemoryStream
  $r.RawContentStream.CopyTo($ms)
  return @{ Status = [int]$r.StatusCode; Headers = $r.Headers; Body = [Text.Encoding]::UTF8.GetString($ms.ToArray()) }
}

$script:session = $null
$script:id = 0
function Headers {
  $h = @{ 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2025-11-25'; Authorization = "Bearer $token" }
  if ($script:session) { $h['Mcp-Session-Id'] = $script:session }
  $h
}
function Rpc($method, $params) {
  $script:id++
  $msg = @{ jsonrpc = '2.0'; id = $script:id; method = $method }
  if ($null -ne $params) { $msg.params = $params }
  Start-Sleep -Milliseconds 120   # the server admits at most 16 requests per second
  $res = Send ($msg | ConvertTo-Json -Depth 30 -Compress) (Headers)
  if ($res.Status -ne 200) { return @{ http = $res.Status; error = $res.Body } }
  $res.Body | ConvertFrom-Json
}
function Tool($name, $arguments) {
  $r = Rpc 'tools/call' @{ name = $name; arguments = $arguments }
  if ($r.http) { return @{ ok = $false; data = $r } }
  # Tool results are enveloped: {ok:true,result:{...}} or {ok:false,error:{code,...}}.
  $sc = $r.result.structuredContent
  if ($sc.ok) { @{ ok = $true; data = $sc.result } } else { @{ ok = $false; data = $sc } }
}
function Js($o) { $o | ConvertTo-Json -Compress -Depth 12 }

Write-Host "`nNevis MCP smoke test -> $url" -ForegroundColor Cyan

Write-Host "`n[Security]"
$init = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"nevis-smoke","version":"1"}}}'
$base = @{ 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream' }
$r = Send $init $base
Check 'request without token is rejected (401)' ($r.Status -eq 401) "got $($r.Status)"
$r = Send $init ($base + @{ Authorization = 'Bearer wrong-token' })
Check 'wrong token is rejected (401)' ($r.Status -eq 401) "got $($r.Status)"
$r = Send $init ($base + @{ Authorization = "Bearer $token"; Origin = 'http://evil.example' })
Check 'browser Origin header is rejected (403)' ($r.Status -eq 403) "got $($r.Status)"
try { $g = Invoke-WebRequest -Uri $url -Method Get -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing; $gs = [int]$g.StatusCode }
catch { $gs = [int]$_.Exception.Response.StatusCode }
Check 'GET is not allowed (405)' ($gs -eq 405) "got $gs"

Write-Host "`n[Protocol]"
$r = Send $init (Headers)
Check 'initialize succeeds' ($r.Status -eq 200) "got $($r.Status): $($r.Body)"
$ini = $r.Body | ConvertFrom-Json
if ($r.Headers['Mcp-Session-Id']) { $script:session = $r.Headers['Mcp-Session-Id'] }
Check 'protocol version 2025-11-25' ($ini.result.protocolVersion -eq '2025-11-25') $ini.result.protocolVersion
Check 'server advertises instructions' ([bool]$ini.result.instructions) ''
Write-Host "        server: $($ini.result.serverInfo.name) $($ini.result.serverInfo.version)"
$null = Send '{"jsonrpc":"2.0","method":"notifications/initialized"}' (Headers)

$tools = (Rpc 'tools/list' $null).result.tools
$expected = 'get_editor_capabilities', 'list_documents', 'search_documents', 'read_document', 'get_document_history', 'create_document', 'edit_document', 'update_document_metadata', 'undo_document_edit', 'list_databases', 'describe_database', 'query_database_rows'
$names = @($tools | ForEach-Object { $_.name })
$missing = @($expected | Where-Object { $names -notcontains $_ })
Check "twelve tools listed ($($names.Count))" ($missing.Count -eq 0) "missing: $($missing -join ', ')"
Check 'every tool has a title and description' (@($tools | Where-Object { -not $_.title -or -not $_.description }).Count -eq 0) ''

Write-Host "`n[Read tools]"
$cap = Tool 'get_editor_capabilities' @{}
Check 'get_editor_capabilities' $cap.ok (Js $cap.data)
$dbs = Tool 'list_databases' @{}
Check 'list_databases' $dbs.ok (Js $dbs.data)
$dbList = @($dbs.data.databases | Where-Object { $_ })
Write-Host "        $($dbList.Count) database(s) visible"
if ($dbList.Count -gt 0) {
  $dbDesc = Tool 'describe_database' @{ sourceId = $dbList[0].sourceId }
  Check 'describe_database' $dbDesc.ok (Js $dbDesc.data)
  $dbRows = Tool 'query_database_rows' @{ sourceId = $dbList[0].sourceId; limit = 5 }
  Check 'query_database_rows' $dbRows.ok (Js $dbRows.data)
}
$list = Tool 'list_documents' @{}
Check 'list_documents' $list.ok (Js $list.data)
$docs = @($list.data.documents | Where-Object { $_ })
Write-Host "        $($docs.Count) document(s) visible to this connection"
if ($docs.Count -gt 0) {
  $first = $docs[0]
  Write-Host "        first: $($first.metadata.title)  [$($first.documentId)]"
  # Pages with content the editor cannot represent answer CAPABILITY_UNAVAILABLE on purpose, so try each page until one reads.
  $out = $null
  foreach ($d in $docs) { $out = Tool 'read_document' @{ documentId = $d.documentId; target = @{ kind = 'outline' }; format = 'structured' }; if ($out.ok) { break } }
  Check 'read_document (outline) on at least one page' $out.ok (Js $out.data)
  $word = ($first.metadata.title -split '\s+' | Where-Object { $_.Length -ge 2 } | Select-Object -First 1)
  if ($word) {
    $s = Tool 'search_documents' @{ query = $word; mode = 'keywords' }
    Check "search_documents ('$word')" $s.ok (Js $s.data)
  }
} else {
  Write-Host '        (list_documents returned nothing: the vault is empty or no roots / "All documents" were selected before Enable connection)' -ForegroundColor Yellow
}

# What an AI can actually do with this vault's content: which block types exist and which pages read in full.
Write-Host "`n[Coverage]  (read-only)"
if ($cap.ok) {
  $types = @($cap.data.nodes | ForEach-Object { $_.type })
  Write-Host "        $($types.Count) block types the editor accepts. Database-related: $(($types | Where-Object { $_ -match 'database|db' }) -join ', ')"
  Write-Host "        Drawing/diagram-related: $(($types | Where-Object { $_ -match 'draw|excali|mermaid|diagram' }) -join ', ')"
}
$readable = 0; $blocked = @()
foreach ($d in $docs) {
  $x = Tool 'read_document' @{ documentId = $d.documentId; target = @{ kind = 'full' }; format = 'structured' }
  if ($x.ok) { $readable++ } else { $blocked += "$($d.metadata.title) [$($x.data.error.code)]" }
}
Write-Host "        $readable of $($docs.Count) pages read in full"
foreach ($b in $blocked) { Write-Host "        cannot read: $b" -ForegroundColor Yellow }

if ($Write) {
  Write-Host "`n[Write tools]  (creates a throw-away page)"
  $run = [guid]::NewGuid().ToString('N').Substring(0, 8)
  # Persian text is built from code points so this file stays ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).
  $fa = -join ([char[]](0x0633, 0x0644, 0x0627, 0x0645, 0x20, 0x0646, 0x0648, 0x06cc, 0x0633))
  $createArgs = @{
    operationId = "smoke-create-$run"; parentId = $null; kind = 'page'
    metadata = @{ title = "MCP smoke test $run $fa"; tags = @('smoke-test'); favorite = $false }
    content = @{ type = 'doc'; content = @(@{ type = 'paragraph'; content = @(@{ type = 'text'; text = 'Created by tools/test-mcp.ps1' }) }) }
  }
  $c = Tool 'create_document' $createArgs
  Check 'create_document' $c.ok (Js $c.data)
  if ($c.ok) {
    $docId = $c.data.documentId
    $l2 = Tool 'list_documents' @{}
    Check 'created page appears in list_documents' ($l2.ok -and (Js $l2.data) -match $docId) (Js $l2.data)
    $c2 = Tool 'create_document' $createArgs
    Check 'retry with the same operationId returns the same page' ($c2.ok -and $c2.data.documentId -eq $docId) (Js $c2.data)

    $mdArgs = @{
      operationId = "smoke-md-$run"; parentId = $null; kind = 'page'
      metadata = @{ title = "MCP markdown test $run"; tags = @('smoke-test'); favorite = $false }
      markdown = "# Heading`n`nA paragraph with **bold** text and $fa.`n`n- one`n- two`n`n| a | b |`n|---|---|`n| 1 | 2 |"
    }
    $md = Tool 'create_document' $mdArgs
    Check 'create_document from markdown' $md.ok (Js $md.data)
    if ($md.ok) {
      $mdRead = Tool 'read_document' @{ documentId = $md.data.documentId; target = @{ kind = 'full' }; format = 'markdown' }
      $mdJson = Js $mdRead.data
      Check 'markdown became real blocks (heading, list, table) and kept Persian' ($mdRead.ok -and $mdJson -match 'Heading' -and $mdJson -match 'two' -and $mdJson.Contains($fa)) ''
    }

    $editArgs = @{
      documentId = $docId; operationId = "smoke-edit-$run"; expectedRevision = $c.data.revision; mode = 'preview'
      operations = @(@{ kind = 'insert_blocks'; at = @{ position = 'end'; parent = $null }
          blocks = @(@{ temporaryId = 'n1'; node = @{ type = 'paragraph'; content = @(@{ type = 'text'; text = "SMOKE_APPEND $fa" }) } }) })
    }
    $p = Tool 'edit_document' $editArgs
    Check 'edit_document preview' $p.ok (Js $p.data)
    $afterPreview = Tool 'read_document' @{ documentId = $docId; target = @{ kind = 'full' }; format = 'structured' }
    Check 'preview did not change the page' ($afterPreview.ok -and (Js $afterPreview.data) -notmatch 'SMOKE_APPEND') ''

    $editArgs.mode = 'apply'
    $e = Tool 'edit_document' $editArgs
    Check 'edit_document apply' $e.ok (Js $e.data)
    $stale = $editArgs.Clone(); $stale.operationId = "smoke-stale-$run"
    $st = Tool 'edit_document' $stale
    Check 'stale revision is rejected (REVISION_CONFLICT)' ((-not $st.ok) -and (Js $st.data) -match 'REVISION_CONFLICT') (Js $st.data)
    $rb = Tool 'read_document' @{ documentId = $docId; target = @{ kind = 'full' }; format = 'structured' }
    $json = Js $rb.data
    Check 'read-back contains the appended text (incl. Persian)' ($rb.ok -and $json -match 'SMOKE_APPEND' -and $json.Contains($fa)) ''

    if ($e.ok) {
      $u = Tool 'undo_document_edit' @{ documentId = $docId; operationId = "smoke-undo-$run"; undoOperationId = "smoke-edit-$run"; mode = 'apply'; expectedRevision = $e.data.saved.revision }
      Check 'undo_document_edit' $u.ok (Js $u.data)
      $rb2 = Tool 'read_document' @{ documentId = $docId; target = @{ kind = 'full' }; format = 'structured' }
      Check 'undo removed the appended text' ($rb2.ok -and (Js $rb2.data) -notmatch 'SMOKE_APPEND') ''
      if ($u.ok) {
        $m = Tool 'update_document_metadata' @{ documentId = $docId; operationId = "smoke-meta-$run"; expectedRevision = $u.data.revision; patch = @{ title = "MCP smoke test $run (done)" } }
        Check 'update_document_metadata' $m.ok (Js $m.data)
      }
    }
    $h = Tool 'get_document_history' @{ documentId = $docId }
    Check 'get_document_history' $h.ok (Js $h.data)
    Write-Host "        left a page titled 'MCP smoke test $run ...' in the vault - delete it in Nevis when done." -ForegroundColor Yellow
  }
} else {
  Write-Host "`n(Run with -Write to also test create/edit/undo. It needs 'Allow document editing' enabled.)" -ForegroundColor DarkGray
}

Write-Host ''
$color = if ($script:fail) { 'Red' } else { 'Green' }
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $color
exit ([int][bool]$script:fail)
