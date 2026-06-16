# MacroSnap local server — no Node/Python needed.
# Run:  powershell -ExecutionPolicy Bypass -File serve.ps1
# Then open http://localhost:8000 in your browser.
$port = 8000
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "MacroSnap running at http://localhost:$port/  (Ctrl+C to stop)" -ForegroundColor Green
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
    if ([string]::IsNullOrEmpty($path)) { $path = 'index.html' }
    $file = Join-Path $root $path
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      switch ([System.IO.Path]::GetExtension($file).ToLower()) {
        '.html'        { $ct = 'text/html; charset=utf-8' }
        '.js'          { $ct = 'text/javascript; charset=utf-8' }
        '.css'         { $ct = 'text/css; charset=utf-8' }
        '.json'        { $ct = 'application/json; charset=utf-8' }
        '.webmanifest' { $ct = 'application/manifest+json; charset=utf-8' }
        '.png'         { $ct = 'image/png' }
        default        { $ct = 'application/octet-stream' }
      }
      $ctx.Response.ContentType = $ct
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
