import AppKit
import WebKit
import Foundation

final class RoomProbe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var testWindow: NSWindow?
    var activity: NSObjectProtocol?
    var finished = false
    let app = NSApplication.shared
    var config: [String: Any] = [:]
    func finish(_ value: Any, code: Int32 = 0) {
        guard !finished else { return }; finished = true
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: bytes, encoding: .utf8) { print(text) }
        web?.stopLoading(); testWindow?.orderOut(nil); if let activity = activity { ProcessInfo.processInfo.endActivity(activity) }; exit(code)
    }
    func start() {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count < 100_000, let value = try? JSONSerialization.jsonObject(with: input) as? [String: Any], let target = value["url"] as? String, let url = URL(string: target), ["http", "https"].contains(url.scheme ?? ""), let initJS = value["initJS"] as? String else { finish(["error":"invalid test configuration"], code:2); return }
        config = value
        app.setActivationPolicy(.accessory)
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Bounded Café Space WebKit connectivity test")
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "probe")
        configuration.userContentController.addUserScript(WKUserScript(source: initJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        web.navigationDelegate = self
        let window = NSWindow(contentRect: CGRect(x: 60, y: 60, width: 390, height: 844), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Café Space · isolated WebKit test"
        window.isReleasedWhenClosed = false; window.contentView = web
        window.orderFront(nil); testWindow = window
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25))
        DispatchQueue.main.asyncAfter(deadline: .now() + 65) {
            self.web.evaluateJavaScript("JSON.stringify({passed:false,error:'test deadline',visibility:document.visibilityState,peer:window.__rtcPC?.connectionState,dtls:window.__rtcPC?.sctp?.transport?.state,sctp:window.__rtcPC?.sctp?.state,trace:window.__rtcTrace||[]})") { result, _ in
                if let s = result as? String, let b = s.data(using: .utf8), let v = try? JSONSerialization.jsonObject(with:b) { self.finish(v,code:1) }
                else { self.finish(["error":"WebKit deadline"],code:1) }
            }
        }
        app.run()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { finish(message.body) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(["error":"navigation", "code":(error as NSError).code], code:1) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let script = config.removeValue(forKey: "runJS") as? String else { return }
        webView.evaluateJavaScript(script) { _, error in if let error = error { self.finish(["error":"evaluation", "code":(error as NSError).code], code:1) } }
    }
}
let probe = RoomProbe(); probe.start()
