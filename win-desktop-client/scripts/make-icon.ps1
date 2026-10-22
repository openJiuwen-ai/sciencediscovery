# ScienceDiscovery installer icon builder (F10)
# Renders a 256x256 PNG with .NET System.Drawing and wraps it into an .ico
# (single PNG-in-ICO entry, Vista+ format). Deterministic, no native deps.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $build | Out-Null
$pngPath = Join-Path $build "icon-256.png"
$icoPath = Join-Path $build "icon.ico"

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Deep science blue rounded square.
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 23, 78, 126))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 48
$rect = New-Object System.Drawing.Rectangle(8, 8, ($size - 16), ($size - 16))
$path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$path.AddArc(($rect.Right - $r), $rect.Y, $r, $r, 270, 90)
$path.AddArc(($rect.Right - $r), ($rect.Bottom - $r), $r, $r, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $r), $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($bg, $path)

# White "SD" monogram.
$font = New-Object System.Drawing.Font("Segoe UI", 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fg = [System.Drawing.Brushes]::White
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("SD", $Font, $fg, (New-Object System.Drawing.RectangleF(0, 4, $size, $size)), $fmt)

$g.Dispose()
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# Wrap the PNG into an ICO container (PNG-in-ICO, 256px entry).
$png = [System.IO.File]::ReadAllBytes($pngPath)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)                # reserved
$bw.Write([UInt16]1)                # type: icon
$bw.Write([UInt16]1)                # count
$bw.Write([byte]0)                  # width 256 (0 = 256)
$bw.Write([byte]0)                  # height 256
$bw.Write([byte]0)                  # palette
$bw.Write([byte]0)                  # reserved
$bw.Write([UInt16]1)                # color planes
$bw.Write([UInt16]32)               # bits per pixel
$bw.Write([UInt32]$png.Length)      # data size
$bw.Write([UInt32](6 + 16))         # data offset (header + 1 entry)
$bw.Write($png)
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose()

Write-Host "icon written: $icoPath ($((Get-Item $icoPath).Length) bytes)"
