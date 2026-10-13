package remote

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "os"
 "strings"
 "testing"
 "time"
)
func localControlCall(t *testing.T,a *Agent,body map[string]any,change func(*http.Request))*httptest.ResponseRecorder{
 t.Helper();raw,err:=json.Marshal(body);if err!=nil{t.Fatal(err)}
 r:=httptest.NewRequest("POST","http://127.0.0.1:37891/api/room/control",strings.NewReader(string(raw)));r.RemoteAddr="127.0.0.1:4321";r.Header.Set("Content-Type","application/json");r.Header.Set("Origin","http://127.0.0.1:37891");r.Header.Set("X-Cafe-Room","1");if change!=nil{change(r)}
 w:=httptest.NewRecorder();a.WrapRoomLocal(http.NotFoundHandler()).ServeHTTP(w,r);return w
}
func controlBody(operation string,extra map[string]any)map[string]any{body:=map[string]any{"token":"123456","operation":operation};for k,v:=range extra{body[k]=v};return body}
func enableApproval(t *testing.T,a *Agent)uint64{t.Helper();r:=localControlCall(t,a,controlBody("configure",map[string]any{"revision":1,"enabled":true}),nil);if r.Code!=200{t.Fatal(r.Code,r.Body.String())};var v roomOwnerControlView;if json.Unmarshal(r.Body.Bytes(),&v)!=nil||!v.Enabled||v.Revision!=2{t.Fatal("failed to enable approval")};return v.Revision}
func pendingFor(t *testing.T,a *Agent,who string)ControlApplication{t.Helper();var result ControlApplication;eventually(t,func()bool{q,_:=a.control.LocalControl("main");for _,v:=range q{if v.Applicant==who&&v.State=="pending"{result=v;return true}};return false});return result}
func TestRoomControlHTTPOnlyAcceptsLocalOwnerAndExactShapes(t *testing.T){
 f:=roomFixture(t,false);before,_:=os.ReadFile(f.agent.cfg.RoomIdentityFile)
 w:=localControlCall(t,f.agent,controlBody("status",nil),nil);if w.Code!=200{t.Fatal(w.Code)};var v roomOwnerControlView;json.Unmarshal(w.Body.Bytes(),&v);if v.Enabled||v.Revision!=1||len(v.Leases)!=0{t.Fatal("wrong default")}
 for _,change:=range []func(*http.Request){func(r *http.Request){r.RemoteAddr="192.0.2.1:44"},func(r *http.Request){r.Header.Set("Origin","https://space.cafecode.work")},func(r *http.Request){r.Header.Del("Origin")},func(r *http.Request){r.Header.Add("Origin","http://127.0.0.1:37891")},func(r *http.Request){r.Host="evil.invalid:37891"},func(r *http.Request){r.Header.Del("X-Cafe-Room")},func(r *http.Request){r.URL.RawQuery="x=1"},func(r *http.Request){r.Method="GET"}}{
  w:=localControlCall(t,f.agent,controlBody("configure",map[string]any{"revision":1,"enabled":true}),change);if w.Code<400{t.Fatal("untrusted owner request accepted")}
 }
 if w:=localControlCall(t,f.agent,map[string]any{"operation":"configure","token":"bad","revision":1,"enabled":true},nil);w.Code!=401{t.Fatal("bad token accepted")}
 for _,body:=range []map[string]any{controlBody("configure",map[string]any{"revision":1}),controlBody("configure",map[string]any{"revision":1,"enabled":true,"hostId":"pi-a"}),controlBody("status",map[string]any{"enabled":true}),controlBody("approve",map[string]any{"revision":1,"applicationId":"missing","force":true})}{if localControlCall(t,f.agent,body,nil).Code<400{t.Fatal("invalid shape accepted")}}
 if f.agent.roomControl.snapshot().Enabled{t.Fatal("rejected calls changed policy")};enableApproval(t,f.agent)
 if localControlCall(t,f.agent,controlBody("configure",map[string]any{"revision":1,"enabled":false}),nil).Code!=409{t.Fatal("stale settings overwrite")}
 after,_:=os.ReadFile(f.agent.cfg.RoomIdentityFile);if string(before)!=string(after){t.Fatal("settings altered identity/password")}
 remote:=httptest.NewRequest("POST",f.server.URL+"/api/room/control",strings.NewReader(`{"token":"123456","operation":"status"}`));rw:=httptest.NewRecorder();f.cloud.Wrap(http.NotFoundHandler()).ServeHTTP(rw,remote);if rw.Code==200{t.Fatal("cloud exposes owner control")}
}
func TestRoomControlRTCRequiresActualLocalApproval(t *testing.T){
 f:=roomFixture(t,false);r:=connectRoom(t,f,false);r.authenticate("123456");r.receive("room.authenticated");r.hello();r.receive("remote.presence")
 // Default-off operators act directly. The same live connection must be gated
 // immediately when the local owner enables approval.
 r.send(prompt("default-write","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1})
 revision:=enableApproval(t,f.agent);r.send(prompt("before-approval","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("enabled policy bypassed")}
 r.send(control("ask","pi-a","acquire",false));if r.receive("remote.result")["ok"]!=true{t.Fatal("request failed")};q:=pendingFor(t,f.agent,r.b.opened.ID)
 if f.agent.control.CanWrite(Identity{ID:r.b.opened.ID},"pi-a")==""{t.Fatal("partial identity accepted")}
 r.send(map[string]any{"type":"remote.control","requestId":"self-approve","hostId":"pi-a","action":"approve","applicationId":q.ID});if r.receive("remote.result")["code"]!="INVALID_REQUEST"{t.Fatal("remote visitor approved itself")}
 r.send(prompt("pending-write","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("pending request granted")};if f.host["pi-a"].count("routed_command")!=1{t.Fatal("pending command leaked")}
 wrong:=localControlCall(t,f.agent,controlBody("approve",map[string]any{"revision":revision,"applicationId":q.ID}),func(r *http.Request){r.Header.Set("Origin","https://example.invalid")});if wrong.Code!=403{t.Fatal("cross-site approve")}
 denied:=localControlCall(t,f.agent,controlBody("deny",map[string]any{"revision":revision,"applicationId":q.ID}),nil);if denied.Code!=200{t.Fatal("deny failed")}
 r.send(control("ask-again","pi-a","acquire",false));r.receive("remote.result");q=pendingFor(t,f.agent,r.b.opened.ID)
 approved:=localControlCall(t,f.agent,controlBody("approve",map[string]any{"revision":revision,"applicationId":q.ID}),nil);if approved.Code!=200{t.Fatal(approved.Code,approved.Body.String())}
 time.Sleep(60*time.Millisecond);if f.host["pi-a"].count("routed_command")!=1{t.Fatal("approval replayed pending command")}
 r.send(prompt("approved-write","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==2})
 r.send(prompt("other-instance","pi-b"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("cross-instance authorization")}
 if localControlCall(t,f.agent,controlBody("revoke",map[string]any{"revision":revision,"hostId":"pi-a","applicationId":q.ID}),nil).Code!=200{t.Fatal("revoke failed")}
 r.send(prompt("revoked-write","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("revoked holder wrote")}
 if localControlCall(t,f.agent,controlBody("approve",map[string]any{"revision":revision,"applicationId":q.ID}),nil).Code!=409{t.Fatal("replayed grant")}
 r.send(control("third-request","pi-a","acquire",false));r.receive("remote.result");q=pendingFor(t,f.agent,r.b.opened.ID)
 r.dc.Close();eventually(t,func()bool{_,ok:=f.agent.control.Application("main",q.ID);return !ok})
 if localControlCall(t,f.agent,controlBody("approve",map[string]any{"revision":revision,"applicationId":q.ID}),nil).Code!=409{t.Fatal("disconnected visitor approved")}
}
