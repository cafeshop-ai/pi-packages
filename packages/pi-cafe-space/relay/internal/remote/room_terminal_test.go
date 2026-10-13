package remote

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)
func TestCafeTerminalReadOnlyAndExplicitSharing(t *testing.T) {
 f:=roomFixture(t,false); f.agent.backend.HostToken="terminal-fixture-host"
 handler:=f.agent.WrapRoomLocal(http.NotFoundHandler())
 call:=func(body string,change func(*http.Request))*httptest.ResponseRecorder{
  r:=httptest.NewRequest("POST","http://127.0.0.1:37891/api/room/terminal",strings.NewReader(body));r.RemoteAddr="127.0.0.1:20000"
  r.Header.Set("Content-Type","application/json");r.Header.Set("Authorization","Bearer terminal-fixture-host");r.Header.Set("X-Cafe-Terminal","1")
  if change!=nil{change(r)};w:=httptest.NewRecorder();handler.ServeHTTP(w,r);return w
 }
 status:=`{"operation":"status","room":"main","peerId":"pi-a"}`
 w:=call(status,nil);if w.Code!=200{t.Fatal(w.Code,w.Body.String())};var v map[string]any;_ = json.Unmarshal(w.Body.Bytes(),&v)
 if v["activeInstances"]!=float64(2)||v["currentPiInRoom"]!=true||v["online"]!=true{t.Fatal("wrong room metadata",v)}
 for _,key:=range []string{"roomKey","url","password","privateKey"}{if _,ok:=v[key];ok{t.Fatal("status leaked sensitive sharing field",key)}}
 share:=call(`{"operation":"share","room":"main","peerId":"pi-a"}`,nil);_ = json.Unmarshal(share.Body.Bytes(),&v);key,_:=f.agent.room.snapshot();if share.Code!=200||v["url"]!=f.server.URL+"/#/room/"+key{t.Fatal("incorrect explicit invitation")}
 for _,secret:=range []string{"terminal-fixture-host","123456",f.agent.room.record.PrivateKey,f.agent.room.record.Verifier}{if strings.Contains(share.Body.String(),secret){t.Fatal("secret in terminal response")}}
 for name,change:=range map[string]func(*http.Request){
  "client token":func(r *http.Request){r.Header.Set("Authorization","Bearer 123456")},
  "browser origin":func(r *http.Request){r.Header.Set("Origin","http://127.0.0.1:37891")},
  "cross origin":func(r *http.Request){r.Header.Set("Origin","https://evil.invalid")},
  "remote peer":func(r *http.Request){r.RemoteAddr="192.0.2.1:1234"},
  "rebinding":func(r *http.Request){r.Host="evil.invalid:37891"},
  "missing header":func(r *http.Request){r.Header.Del("X-Cafe-Terminal")},
 }{t.Run(name,func(t *testing.T){if call(status,change).Code==200{t.Fatal("unauthorized read accepted")}})}
 for _,body:=range []string{`{"operation":"password","room":"main","peerId":"pi-a"}`,`{"operation":"status","room":"main","peerId":"pi-a","password":"changed"}`,`{"operation":"status","operation":"share","room":"main","peerId":"pi-a"}`,strings.Repeat("a",2049)}{if call(body,nil).Code==200{t.Fatal("management or invalid frame accepted")}}
 keyAfter,_:=f.agent.room.snapshot();if keyAfter!=key{t.Fatal("read-only endpoint changed room identity")}
}
