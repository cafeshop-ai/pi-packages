import AppKit
import WebKit
import Foundation

final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var finished = false
    let app = NSApplication.shared
    func finish(_ value: Any, code: Int32 = 0) {
        guard !finished else { return }; finished = true
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: bytes, encoding: .utf8) { print(text) }
        web?.stopLoading(); exit(code)
    }
    func start() {
        app.setActivationPolicy(.prohibited)
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "probe")
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        web.navigationDelegate = self
        guard let url = URL(string: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "https://space.cafecode.work/") else { finish(["error":"invalid target"], code:2); return }
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.finish(["error":"WebKit probe deadline"], code:1) }
        app.run()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { finish(message.body) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(["error":"navigation", "code":(error as NSError).code], code:1) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let script = """
        (() => {
          const result={runtime:navigator.userAgent,steps:[],violations:[]};
          const step=(name,fn)=>{try{fn();result.steps.push({name,ok:true});}catch(e){result.steps.push({name,ok:false,error:e.name});}};
          addEventListener('securitypolicyviolation', e=>result.violations.push({directive:e.effectiveDirective,blockedScheme:e.blockedURI.split(':')[0]}));
          step('AbortController',()=>new AbortController());
          step('secureRandom',()=>crypto.getRandomValues(new Uint8Array(32)));
          step('base64',()=>btoa(String.fromCharCode(...new Uint8Array(32))));
          step('URL',()=>{const u=new URL(location.origin);if(u.pathname!=='/')throw Error('origin');u.protocol='wss:';u.pathname='/room/join';});
          step('WebSocket',()=>{const u=new URL(location.origin);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/room/join';const ws=new WebSocket(u.href);ws.addEventListener('open',()=>{result.opened=true;ws.close();});ws.addEventListener('error',()=>{result.socketError=true;});setTimeout(()=>ws.close(),1500);});
          setTimeout(()=>window.webkit.messageHandlers.probe.postMessage(result),2000);
        })()
        """
        webView.evaluateJavaScript(script) { _, error in if let error = error { self.finish(["error":"evaluation", "code":(error as NSError).code], code:1) } }
    }
}
let probe = Probe(); probe.start()
