package remote

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)
func terminalOwnerCall(t *testing.T,a *Agent,body map[string]any,change func(*http.Request))*httptest.ResponseRecorder{
 t.Helper();raw,_:=json.Marshal(body);r:=httptest.NewRequest("POST","http://127.0.0.1:37891/api/room/terminal-owner",strings.NewReader(string(raw)));r.RemoteAddr="127.0.0.1:4321";r.Header.Set("Content-Type","application/json");r.Header.Set("X-Cafe-Local-Owner","1");r.Header.Set("Authorization","Bearer 123456");r.Header.Set("X-Cafe-Pi-Authorization","Bearer fixture-host");if change!=nil{change(r)};w:=httptest.NewRecorder();a.WrapRoomLocal(http.NotFoundHandler()).ServeHTTP(w,r);return w
}
func TestTerminalOwnerRequiresBothCredentialsAndLocalRegisteredPi(t *testing.T){
 f:=roomFixture(t,false);f.agent.backend.HostToken="fixture-host"
 body:=map[string]any{"operation":"status","room":"main","peerId":"pi-a"}
 if r:=terminalOwnerCall(t,f.agent,body,nil);r.Code!=200{t.Fatal(r.Code,r.Body.String())}
 for _,change:=range []func(*http.Request){func(r *http.Request){r.Header.Del("Authorization")},func(r *http.Request){r.Header.Set("Authorization","Bearer fixture-host")},func(r *http.Request){r.Header.Del("X-Cafe-Pi-Authorization")},func(r *http.Request){r.Header.Add("Authorization","Bearer 123456")},func(r *http.Request){r.Header.Set("Origin","http://127.0.0.1:37891")},func(r *http.Request){r.RemoteAddr="192.0.2.3:1234"},func(r *http.Request){r.Host="evil.example:37891"},func(r *http.Request){r.URL.RawQuery="x=1"},func(r *http.Request){r.Method="GET"}}{if terminalOwnerCall(t,f.agent,body,change).Code<400{t.Fatal("untrusted terminal accepted")}}
 body["peerId"]="nonexistent";if terminalOwnerCall(t,f.agent,body,nil).Code!=403{t.Fatal("unregistered Pi")};body["peerId"]="pi-a"
 body["operation"]="configure";body["enabled"]=false;body["revision"]=1;if terminalOwnerCall(t,f.agent,body,nil).Code!=400{t.Fatal("terminal can configure room")}
}
func TestTerminalOwnerApprovalScopesToPiAndReusesOwnerGate(t *testing.T){
 f:=roomFixture(t,false);f.agent.backend.HostToken="fixture-host";revision:=enableApproval(t,f.agent)
 r:=connectRoom(t,f,false);r.authenticate("123456");r.receive("room.authenticated");r.hello();r.send(control("request-a","pi-a","acquire",false));r.receive("remote.result");q:=pendingFor(t,f.agent,r.b.opened.ID)
 status:=terminalOwnerCall(t,f.agent,map[string]any{"operation":"status","room":"main","peerId":"pi-b"},nil);if status.Code!=200||strings.Contains(status.Body.String(),q.ID){t.Fatal("another Pi request exposed")}
 body:=map[string]any{"operation":"approve","room":"main","peerId":"pi-b","revision":revision,"applicationId":q.ID};if terminalOwnerCall(t,f.agent,body,nil).Code!=409{t.Fatal("cross-Pi approve")};body["peerId"]="pi-a";body["revision"]=revision-1;if terminalOwnerCall(t,f.agent,body,nil).Code!=409{t.Fatal("stale policy approve")};body["revision"]=revision
 // Possessing only the Pi host token still cannot mutate the old read-only API.
 old:=terminalOwnerCall(t,f.agent,map[string]any{"operation":"approve","room":"main","peerId":"pi-a"},func(r *http.Request){r.URL.Path="/api/room/terminal";r.Header.Set("Authorization","Bearer fixture-host");r.Header.Set("X-Cafe-Terminal","1")});if old.Code!=400{t.Fatal("old read-only terminal API granted approval")}
 r.send(prompt("before-owner","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("unapproved write")}
 result:=terminalOwnerCall(t,f.agent,body,nil);if result.Code!=200{t.Fatal(result.Code,result.Body.String())};if f.host["pi-a"].count("routed_command")!=0{t.Fatal("approval replayed command")}
 r.send(prompt("after-owner","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1});if terminalOwnerCall(t,f.agent,body,nil).Code!=409{t.Fatal("approval replay")}
 if localControlCall(t,f.agent,controlBody("revoke",map[string]any{"revision":revision,"hostId":"pi-a","applicationId":q.ID}),nil).Code!=200{t.Fatal("web cannot revoke terminal grant")}
 r.send(control("request-again","pi-a","acquire",false));r.receive("remote.result");q=pendingFor(t,f.agent,r.b.opened.ID);body["operation"]="deny";body["applicationId"]=q.ID;if terminalOwnerCall(t,f.agent,body,nil).Code!=200{t.Fatal("terminal deny")};r.send(prompt("after-denial","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("denied write")}
}
