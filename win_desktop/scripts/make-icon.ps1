# ScienceDiscovery installer icon builder
# Derives build/icon-256.png and build/icon.ico from the single checked-in
# source artwork, docs/images/logo.png, instead of redrawing the mark.
#
# It scales the source to 256x256 for build/icon-256.png and re-wraps the
# .ico with PNG entries at 16/24/32/48/64/128/256 so Windows surfaces never
# downscale a lone 256 px frame. Deterministic, no native deps beyond
# System.Drawing (Windows).
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repoRoot "docs/images/logo.png"
if (-not (Test-Path -LiteralPath $source)) {
  throw "source artwork not found: $source"
}

$build = Join-Path $repoRoot "win_desktop/build"
New-Item -ItemType Directory -Force -Path $build | Out-Null
$pngPath = Join-Path $build "icon-256.png"
$icoPath = Join-Path $build "icon.ico"

$srcImg = [System.Drawing.Image]::FromFile($source)
try {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $pngs = @{}
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($srcImg, 0, 0, $s, $s)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs[$s] = $ms.ToArray()
    $g.Dispose(); $bmp.Dispose(); $ms.Dispose()
  }

  [System.IO.File]::WriteAllBytes($pngPath, $pngs[256])

  # Wrap every size into a Vista+ PNG-in-ICO container.
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0)             # reserved
  $bw.Write([UInt16]1)             # type: icon
  $bw.Write([UInt16]$sizes.Count)  # entry count
  $offset = 6 + 16 * $sizes.Count
  foreach ($s in $sizes) {
    $w = if ($s -eq 256) { 0 } else { $s }
    $bytes = [byte[]]($pngs[$s])
    $bw.Write([byte]$w)            # width (0 == 256)
    $bw.Write([byte]$w)            # height
    $bw.Write([byte]0)             # palette
    $bw.Write([byte]0)             # reserved
    $bw.Write([UInt16]1)           # color planes
    $bw.Write([UInt16]32)          # bits per pixel
    $bw.Write([UInt32]$bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
  }
  foreach ($s in $sizes) {
    $bw.Write([byte[]]($pngs[$s]))
  }
  [System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
  $bw.Dispose()
} finally {
  $srcImg.Dispose()
}

Write-Host ("icon written: {0} ({1} bytes)" -f $icoPath, (Get-Item $icoPath).Length)
Write-Host ("icon source PNG written: {0} ({1} bytes)" -f $pngPath, (Get-Item $pngPath).Length)