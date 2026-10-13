import AppKit
import Foundation
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let paths = Array(CommandLine.arguments.dropFirst())
guard !paths.isEmpty && paths.count <= 3 else { exit(2) }
let window = NSWindow(contentRect: CGRect(x: 80, y: 50, width: 1080, height: 800), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Café Space — mobile visual review"
window.isReleasedWhenClosed = false
let root = NSView(frame: CGRect(x: 0, y: 0, width: 1080, height: 800))
for (index, path) in paths.enumerated() {
    guard let image = NSImage(contentsOfFile: path) else { print("Missing rendered screenshot"); exit(2) }
    let column = CGFloat(index) * 360
    let view = NSImageView(frame: CGRect(x: column + 8, y: 12, width: 344, height: 750))
    view.image = image; view.imageScaling = .scaleProportionallyUpOrDown; root.addSubview(view)
    let label = NSTextField(labelWithString: URL(fileURLWithPath: path).lastPathComponent)
    label.frame = CGRect(x: column + 8, y: 771, width: 344, height: 20); label.alignment = .center; root.addSubview(label)
}
window.contentView = root; window.orderFront(nil)
print("Visual review window ready")
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { window.orderOut(nil); exit(0) }
app.run()
