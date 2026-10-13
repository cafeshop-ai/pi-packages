package httpserver

import (
 "net"
 "net/http"
 "net/url"
 "strings"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
)

// Browsers have differed in whether connect-src 'self' includes ws(s).
// Add only the explicitly configured page origin, never a scheme wildcard.
func WebSocketContentSecurityPolicy(origin string) string {
 base:=securityHeaders["Content-Security-Policy"]
 if origin==""||strings.ContainsAny(origin," \t\r\n\v\f\x00'\";*\\") {return base}
 u,err:=url.Parse(origin)
 if err!=nil||u.User!=nil||u.RawQuery!=""||u.ForceQuery||u.Fragment!=""||u.RawFragment!=""||(u.Path!=""&&u.Path!="/")||u.RawPath!="" {return base}
 normalized,err:=auth.NormalizeOrigin(origin);if err!=nil{return base}
 u,err=url.Parse(normalized);if err!=nil{return base}
 if u.Scheme=="https" {u.Scheme="wss"} else if u.Scheme=="http" {u.Scheme="ws"} else{return base}
 return strings.Replace(base,"connect-src 'self';","connect-src 'self' "+u.String()+";",1)
}

// Unconfigured local pages may name their literal loopback origin. Never trust
// X-Forwarded-* here and never derive a public allowlist from an arbitrary Host.
func localPageContentSecurityPolicy(r *http.Request) string {
 scheme:="http";if r.TLS!=nil{scheme="https"}
 origin:=scheme+"://"+r.Host
 u,err:=url.Parse(origin);if err!=nil{return securityHeaders["Content-Security-Policy"]}
 host:=u.Hostname();ip:=net.ParseIP(host)
 if host!="localhost"&&(ip==nil||!ip.IsLoopback()){return securityHeaders["Content-Security-Policy"]}
 return WebSocketContentSecurityPolicy(origin)
}
