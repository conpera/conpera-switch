import AppKit
import Foundation

// Render the same SVG used by the interface instead of redrawing the logo.
guard CommandLine.arguments.count == 3 else {
    fputs("Usage: generate-icon /path/to/favicon.svg /path/to/ConperaSwitch.iconset\n", stderr)
    exit(1)
}

guard let source = NSImage(contentsOfFile: CommandLine.arguments[1]),
      source.size.width > 0, source.size.width == source.size.height else {
    fputs("The brand source must be a readable square image.\n", stderr)
    exit(1)
}
source.cacheMode = .never

let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func renderIcon(pixels: Int, to file: URL) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "ConperaIcon", code: 1)
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = CGFloat(pixels) / 1024
    context.cgContext.scaleBy(x: scale, y: scale)
    context.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))

    let tileBounds = NSRect(x: 76, y: 76, width: 872, height: 872)
    let tile = NSBezierPath(roundedRect: tileBounds, xRadius: 198, yRadius: 198)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.22)
    shadow.shadowBlurRadius = 38
    shadow.shadowOffset = NSSize(width: 0, height: -14)
    shadow.set()
    NSColor.white.setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()

    // Only the macOS tile adds rounded corners, transparent padding and shadow.
    NSGraphicsContext.saveGraphicsState()
    tile.addClip()
    source.draw(in: tileBounds, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ConperaIcon", code: 2)
    }
    try png.write(to: file, options: .atomic)
}

for size in [16, 32, 128, 256, 512] {
    try renderIcon(pixels: size, to: output.appendingPathComponent("icon_\(size)x\(size).png"))
    try renderIcon(pixels: size * 2, to: output.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
print("Generated macOS icon set: \(output.path)")
