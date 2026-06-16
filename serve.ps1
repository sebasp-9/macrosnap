# MacroSnap local server — no Node/Python needed.
# Run:  powershell -ExecutionPolicy Bypass -File serve.ps1
# Then open http://localhost:8000 in your browser.
$port = 8000
# Canonical, absolute web root. Everything served MUST resolve to inside this.
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$listener = New-Object System.Net.HttpListener
# Binding to "localhost" makes HttpListener match only requests whose Host header
# is "localhost", which also blocks DNS-rebinding attacks from other origins.
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "MacroSnap running at http://localhost:$port/  (Ctrl+C to stop)" -ForegroundColor Green
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    # Defense-in-depth headers (the dev server can set the ones <meta> can't).
    $ctx.Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $ctx.Response.Headers['X-Frame-Options'] = 'DENY'
    $ctx.Response.Headers['Referrer-Policy'] = 'no-referrer'

    # Only GET/HEAD make sense for a static file server.
    if ($ctx.Request.HttpMethod -ne 'GET' -and $ctx.Request.HttpMethod -ne 'HEAD') {
      $ctx.Response.StatusCode = 405
      continue
    }

    $relative = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
    if ([string]::IsNullOrEmpty($relative)) { $relative = 'index.html' }

    # Resolve the requested path and REJECT anything that escapes the web root.
    # GetFullPath collapses ../, %2e%2e and double-encoded sequences alike, so the
    # containment check below defeats directory-traversal regardless of encoding.
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    $inRoot = $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)

    # Never serve dotfiles / dot-directories (.git, .idea, .claude, .env, .gitignore...).
    # Checking the RESOLVED path's segments is authoritative regardless of URL encoding.
    $relToRoot = if ($full.Length -ge $rootPrefix.Length) { $full.Substring($rootPrefix.Length) } else { '' }
    $hasDotSegment = ($relToRoot -split '[\\/]+') | Where-Object { $_ -like '.*' }

    if (-not $inRoot -or $hasDotSegment) {
      $ctx.Response.StatusCode = 403
    } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      switch ([System.IO.Path]::GetExtension($full).ToLower()) {
        '.html'        { $ct = 'text/html; charset=utf-8' }
        '.js'          { $ct = 'text/javascript; charset=utf-8' }
        '.css'         { $ct = 'text/css; charset=utf-8' }
        '.json'        { $ct = 'application/json; charset=utf-8' }
        '.webmanifest' { $ct = 'application/manifest+json; charset=utf-8' }
        '.png'         { $ct = 'image/png' }
        default        { $ct = 'application/octet-stream' }
      }
      $ctx.Response.ContentType = $ct
      # HEAD: report metadata only, no body.
      if ($ctx.Request.HttpMethod -eq 'GET') {
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.ContentLength64 = $bytes.Length
      }
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
