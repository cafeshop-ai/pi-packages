package httpserver

import (
 "net/http/httptest"
 "strings"
 "testing"
)
func TestWebSocketContentSecurityPolicyExactOrigins(t *testing.T){
 for _,tc:=range []struct{origin,want string}{{"https://rooms.example","wss://rooms.example"},{"https://rooms.example:8443/","wss://rooms.example:8443"},{"http://localhost:37891","ws://localhost:37891"},{"http://[::1]:37891","ws://[::1]:37891"}}{
  got:=WebSocketContentSecurityPolicy(tc.origin);if !strings.Contains(got,"connect-src 'self' "+tc.want+";"){t.Fatalf("origin %q: %s",tc.origin,got)}
  if strings.Contains(got,"*")||strings.Contains(got,"'unsafe-"){t.Fatal("overbroad permission")}
 }
}
func TestInvalidWebSocketSourcesFailClosed(t *testing.T){
 for _,origin:=range []string{"","wss://rooms.example","https://user:pass@rooms.example","https://rooms.example/path","https://rooms.example/?token=x","https://rooms.example/?","https://rooms.example/#x","https://*.example","https://rooms.example; connect-src *","https://rooms.example\r\nX-Test: yes","https://rooms.example\\evil","https://rooms.example 'unsafe-eval'"}{
  if got:=WebSocketContentSecurityPolicy(origin);got!=securityHeaders["Content-Security-Policy"]{t.Fatalf("invalid source accepted: %q",origin)}
 }
}
func TestLocalPageIgnoresForwardedHostsAndRestrictsToLoopback(t *testing.T){
 r:=httptest.NewRequest("GET","http://localhost:37891/",nil);r.Header.Set("X-Forwarded-Host","evil.invalid");r.Header.Set("X-Forwarded-Proto","https")
 got:=localPageContentSecurityPolicy(r);if !strings.Contains(got,"ws://localhost:37891")||strings.Contains(got,"evil.invalid"){t.Fatal("wrong local policy",got)}
 r.Host="evil.invalid";if localPageContentSecurityPolicy(r)!=securityHeaders["Content-Security-Policy"]{t.Fatal("untrusted Host created a destination")}
 r.Host="127.0.0.1:37891;evil";if localPageContentSecurityPolicy(r)!=securityHeaders["Content-Security-Policy"]{t.Fatal("injected host accepted")}
}
