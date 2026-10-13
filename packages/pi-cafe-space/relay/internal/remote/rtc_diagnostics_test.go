package remote

import (
 "encoding/json"
 "errors"
 "net/http"
 "net/http/httptest"
 "strings"
 "sync"
 "testing"
 "time"
)
func TestRTCTraceBoundedPrivateAndExpiring(t *testing.T){
 var store rtcDiagnostics
 for i:=0;i<50;i++{a:=store.begin();a.add("session","created");for j:=0;j<80;j++{a.add("ice","checking");a.add("peer","connecting")};a.add("close","VISITOR_LEFT")}
 view:=store.snapshot();if len(view)!=24{t.Fatal("unbounded attempts")};for _,a:=range view{if len(a.Events)>32||a.Events[len(a.Events)-1].Step!="close"{t.Fatal("event bound or final close lost")}}
 a:=store.begin();logger:=rtcTraceLoggerFactory{a}.NewLogger("sctp");logger.Warnf("private token=%s, aborted: %s","DO-NOT-RETAIN","192.0.2.123");logger.Debug("private payload");a.add("private step","private value");a.add("policy","private value")
 raw,_:=json.Marshal(store.snapshot());for _,secret:=range []string{"DO-NOT-RETAIN","192.0.2.123","private payload","private step","private value"}{if strings.Contains(string(raw),secret){t.Fatal("diagnostic leaked unapproved text")}}
 if rtcErrorClass(errors.New("abort reason with private text"))!="PEER_ABORT"||rtcCloseClass("unknown private close")!="OTHER_CLOSE"{t.Fatal("wrong category")}
 store.prune(time.Now().Add(6*time.Minute));if len(store.snapshot())!=0||len(a.events)!=0{t.Fatal("expired trace retained")}
}
func TestRTCTraceConcurrentReadsAndEvents(t *testing.T){
 var store rtcDiagnostics;var group sync.WaitGroup
 for i:=0;i<8;i++{group.Add(1);go func(){defer group.Done();for n:=0;n<100;n++{a:=store.begin();a.add("ice","connected");_ = store.snapshot();a.add("dtls","connected");store.prune(time.Now())}}()};group.Wait()
 if len(store.snapshot())>24{t.Fatal("capacity lost under concurrency")}
}
func TestRTCDiagnosticEndpointIsLocalHostOnly(t *testing.T){
 f:=roomFixture(t,false);f.agent.backend.HostToken="synthetic-diagnostic-host";a:=f.agent.rtcDiagnostics.begin();a.add("dtls","connected");a.add("sctp-error","PEER_ABORT")
 handler:=f.agent.WrapRoomLocal(http.NotFoundHandler())
 call:=func(room string,change func(*http.Request))*httptest.ResponseRecorder{r:=httptest.NewRequest("POST","http://127.0.0.1:37891/api/room/terminal",strings.NewReader(`{"operation":"diagnostics","room":"`+room+`","peerId":"read-only-test"}`));r.RemoteAddr="127.0.0.1:1234";r.Header.Set("Content-Type","application/json");r.Header.Set("X-Cafe-Terminal","1");r.Header.Set("Authorization","Bearer synthetic-diagnostic-host");if change!=nil{change(r)};w:=httptest.NewRecorder();handler.ServeHTTP(w,r);return w}
 w:=call("main",nil);if w.Code!=200||!strings.Contains(w.Body.String(),"PEER_ABORT"){t.Fatal("local trace not available")}
 var value map[string]any;if json.Unmarshal(w.Body.Bytes(),&value)!=nil{t.Fatal("bad JSON")};if len(value)!=3||value["retentionSeconds"]!=float64(300){t.Fatal("unexpected diagnostic fields")}
 for _,secret:=range []string{"roomKey","url","password","synthetic-diagnostic-host",f.agent.room.record.PrivateKey}{if strings.Contains(w.Body.String(),secret){t.Fatal("private identity in diagnostic")}}
 for _,change:=range []func(*http.Request){func(r *http.Request){r.Header.Set("Authorization","Bearer 123456")},func(r *http.Request){r.Header.Set("Origin","http://127.0.0.1:37891")},func(r *http.Request){r.RemoteAddr="192.0.2.1:1234"},func(r *http.Request){r.Host="evil.invalid:37891"},func(r *http.Request){r.Header.Del("X-Cafe-Terminal")}}{if call("main",change).Code==200{t.Fatal("unauthorized diagnostic read")}}
 if call("other",nil).Code==200{t.Fatal("other-room diagnostic access")}
}
func TestRoomHandshakeStillWorksWithDiagnostics(t *testing.T){
 f:=roomFixture(t,false);r:=connectRoom(t,f,false);r.authenticate("123456");r.receive("room.authenticated");r.hello()
 deadline:=time.Now().Add(time.Second);for time.Now().Before(deadline){for _,a:=range f.agent.rtcDiagnostics.snapshot(){for _,e:=range a.Events{if e.Step=="selection"&&e.State=="selected"{return}}};time.Sleep(time.Millisecond*10)}
 t.Fatal("successful handshake not observed")
}
