import AppKit
import Foundation
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let files = Array(CommandLine.arguments.dropFirst())
let canvas = NSView(frame: NSRect(x:0,y:0,width:CGFloat(files.count)*400,height:844))
for (index,path) in files.enumerated() {
 guard let image = NSImage(contentsOfFile:path) else { fatalError("Screenshot missing") }
 let view = NSImageView(frame:NSRect(x:CGFloat(index)*400,y:0,width:390,height:844))
 view.image=image; view.imageScaling = .scaleProportionallyUpOrDown; view.imageAlignment = .alignTop
 canvas.addSubview(view)
}
let window = NSWindow(contentRect:canvas.bounds,styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title="Café Space · mobile visual QA"
window.isReleasedWhenClosed=false;window.contentView=canvas;window.orderFront(nil)
DispatchQueue.main.asyncAfter(deadline:.now()+60){window.orderOut(nil);exit(0)}
app.run()
