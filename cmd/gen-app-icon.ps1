# Regenerate the Windows application icon from the original artwork.
# Usage on Windows: powershell -NoProfile -File cmd/gen-app-icon.ps1
# Requires only the built-in System.Drawing assembly.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconRoot = Split-Path -Parent $PSScriptRoot
$iconSourcePath = Join-Path $iconRoot 'gfx/SumatraPDF.png'
$iconOutputPath = Join-Path $iconRoot 'gfx/SumatraPDF-smaller.ico'
$iconSizes = @(256, 64, 48, 40, 32, 24, 20, 16)

function New-IconFrame([System.Drawing.Image] $Source, [int] $Size) {
    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        # Fit the artwork inside a transparent square without cropping or stretching.
        $scale = $Size / [double][Math]::Max($Source.Width, $Source.Height)
        $width = [Math]::Max(1, [int][Math]::Round($Source.Width * $scale))
        $height = [Math]::Max(1, [int][Math]::Round($Source.Height * $scale))
        $left = [int][Math]::Floor(($Size - $width) / 2)
        $top = [int][Math]::Floor(($Size - $height) / 2)
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $destination = [System.Drawing.Rectangle]::new($left, $top, $width, $height)
        $graphics.DrawImage($Source, $destination, 0, 0, $Source.Width, $Source.Height,
            [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        $graphics.Flush()

        if ($Size -eq 256) {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        } else {
            # Small frames use a 32-bit DIB with an AND mask for Windows icon APIs.
            $andStride = [int]([Math]::Ceiling($Size / 32.0) * 4)
            $andMask = [byte[]]::new($andStride * $Size)
            $writer.Write([uint32]40)
            $writer.Write([int32]$Size)
            $writer.Write([int32]($Size * 2))
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]0)
            $writer.Write([uint32]($Size * $Size * 4))
            $writer.Write([byte[]]::new(16))
            for ($y = $Size - 1; $y -ge 0; $y--) {
                for ($x = 0; $x -lt $Size; $x++) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    $writer.Write([byte]$pixel.B)
                    $writer.Write([byte]$pixel.G)
                    $writer.Write([byte]$pixel.R)
                    $writer.Write([byte]$pixel.A)
                    if ($pixel.A -eq 0) {
                        $maskIndex = ($Size - 1 - $y) * $andStride + [int][Math]::Floor($x / 8)
                        $andMask[$maskIndex] = $andMask[$maskIndex] -bor (0x80 -shr ($x % 8))
                    }
                }
            }
            $writer.Write($andMask)
        }
        return @{ Size = $Size; Data = $stream.ToArray() }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
        $attributes.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$iconSource = [System.Drawing.Image]::FromFile($iconSourcePath)
try {
    $iconFrames = @($iconSizes | ForEach-Object { New-IconFrame $iconSource $_ })
} finally {
    $iconSource.Dispose()
}

$iconStream = [System.IO.MemoryStream]::new()
$iconWriter = [System.IO.BinaryWriter]::new($iconStream)
try {
    $iconWriter.Write([uint16]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]$iconFrames.Count)
    $iconOffset = 6 + 16 * $iconFrames.Count
    foreach ($frame in $iconFrames) {
        $dimension = [byte]($frame.Size % 256)
        $iconWriter.Write($dimension)
        $iconWriter.Write($dimension)
        $iconWriter.Write([uint16]0)
        $iconWriter.Write([uint16]1)
        $iconWriter.Write([uint16]32)
        $iconWriter.Write([uint32]$frame.Data.Length)
        $iconWriter.Write([uint32]$iconOffset)
        $iconOffset += $frame.Data.Length
    }
    foreach ($frame in $iconFrames) {
        $iconWriter.Write([byte[]]$frame.Data)
    }
    [System.IO.File]::WriteAllBytes($iconOutputPath, $iconStream.ToArray())
    Write-Output "Generated $iconOutputPath with sizes: $($iconSizes -join ', ')"
} finally {
    $iconWriter.Dispose()
    $iconStream.Dispose()
}
