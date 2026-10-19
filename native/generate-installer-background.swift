import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: generate-installer-background /path/to/background.tiff\n", stderr)
    exit(1)
}

// Finder uses points for its icon positions. Both TIFF representations share
// this logical size, so the background stays aligned on Retina displays.
let size = NSSize(width: 800, height: 480)
var representations: [NSBitmapImageRep] = []
for scale in [1, 2] {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width) * scale,
        pixelsHigh: Int(size.height) * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Could not create the installer background.")
    }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))

    NSColor(srgbRed: 0.965, green: 0.961, blue: 0.973, alpha: 1).setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

    func text(_ value: String, top: CGFloat, height: CGFloat, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        (value as NSString).draw(in: NSRect(x: 24, y: size.height - top - height, width: size.width - 48, height: height), withAttributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ])
    }
    text("安装 Conpera Switch", top: 60, height: 44,
         font: .systemFont(ofSize: 30, weight: .semibold),
         color: NSColor(srgbRed: 0.12, green: 0.12, blue: 0.14, alpha: 1))
    text("将 Conpera Switch 拖入 Applications 即可安装", top: 110, height: 28,
         font: .systemFont(ofSize: 17),
         color: NSColor(srgbRed: 0.44, green: 0.44, blue: 0.47, alpha: 1))

    // The actual application and Applications alias are draggable Finder items.
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 374, y: size.height - 302))
    arrow.line(to: NSPoint(x: 426, y: size.height - 302))
    arrow.move(to: NSPoint(x: 415, y: size.height - 291))
    arrow.line(to: NSPoint(x: 426, y: size.height - 302))
    arrow.line(to: NSPoint(x: 415, y: size.height - 313))
    arrow.lineWidth = 2.5
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    NSColor(srgbRed: 0.58, green: 0.58, blue: 0.61, alpha: 1).setStroke()
    arrow.stroke()

    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    representations.append(bitmap)
}

guard let tiff = NSBitmapImageRep.tiffRepresentationOfImageReps(in: representations) else {
    fatalError("Could not encode the installer background.")
}
try tiff.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
