package remote

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/gorilla/websocket"
)

type testHost struct { mu sync.Mutex; messages []protocol.Object }
func(h *testHost) Send(raw []byte)error{m,err:=protocol.DecodeWire(raw);if err!=nil{return err};h.mu.Lock();defer h.mu.Unlock();h.messages=append(h.messages,m);return nil}
func(h *testHost) Close(int,string){}
func(h *testHost) count(kind string)int{h.mu.Lock();defer h.mu.Unlock();n:=0;for _,m:=range h.messages{if m["type"]==kind{n++}};return n}
func(h *testHost) last(kind string)protocol.Object{h.mu.Lock();defer h.mu.Unlock();for i:=len(h.messages)-1;i>=0;i--{if h.messages[i]["type"]==kind{return h.messages[i]}};return nil}
type testManager struct{mu sync.Mutex; calls []managed.Request}
func(m *testManager)Execute(q managed.Request)(any,string){m.mu.Lock();defer m.mu.Unlock();m.calls=append(m.calls,q);return map[string]any{"projects":[]any{},"sessions":[]any{},"maxActive":8},""}
type integration struct { cloud *Cloud; agent *Agent; server *httptest.Server; cfg Config; h *hub.Hub; host map[string]*testHost; connections map[string]*hub.Connection; keys map[string]string; manager *testManager }
func eventually(t *testing.T,check func()bool){t.Helper();deadline:=time.Now().Add(5*time.Second);for time.Now().Before(deadline){if check(){return};time.Sleep(10*time.Millisecond)};t.Fatal("condition did not become true")}
func fixture(t *testing.T)*integration{
	t.Helper();f:=&integration{cfg:cloudConfig(),host:map[string]*testHost{},connections:map[string]*hub.Connection{},keys:map[string]string{},manager:&testManager{}}
	f.cfg.EnableWebRTC=true
	f.cfg.Users=nil
	for _,role:=range []string{"viewer","operator","admin"}{key,err:=NewToken();if err!=nil{t.Fatal(err)};f.keys[role]=key;f.cfg.Users=append(f.cfg.Users,User{ID:role,Name:role,TokenHash:TokenHash(key),Grants:[]Grant{{DeviceID:"office",Room:"main",Role:role}}})}
	f.server=httptest.NewUnstartedServer(nil);f.cfg.PublicOrigin="http://"+f.server.Listener.Addr().String()
	var err error;f.cloud,err=NewCloud(f.cfg,"");if err!=nil{t.Fatal(err)}
	f.server.Config.Handler=f.cloud.Wrap(http.NotFoundHandler());f.server.Start()
	ctx,cancel:=context.WithCancel(context.Background());f.cloud.Start(ctx)
	f.h=hub.New(hub.Options{HostToken:"fixture-host",ClientToken:"fixture-client"})
	for _,id:=range []string{"pi-a","pi-b"}{h:=&testHost{};c,err:=f.h.Join(h,"127.0.0.1");if err!=nil{t.Fatal(err)};f.host[id]=h;f.connections[id]=c
		f.native(t,id,protocol.Object{"type":"hello","protocolVersion":float64(1),"peerRole":"host","peerId":id,"roomId":"main","token":"fixture-host"})
		snapshot:=protocol.Object{"protocolVersion":float64(1),"streamId":"stream-"+id,"sessionId":"session-"+id,"sessionName":id,"cwd":"/fixture/project","activeLeafId":nil,"model":nil,"thinkingLevel":"off","phase":"idle","hasPendingMessages":false,"messages":[]any{},"tools":[]any{},"historyTruncated":false,"lastEventSeq":float64(0)}
		f.native(t,id,protocol.Object{"type":"snapshot","snapshot":snapshot})
	}
	dcfg:=Config{Mode:"device",DeviceID:"office",DeviceToken:testDeviceToken,CloudURL:"ws"+strings.TrimPrefix(f.server.URL,"http")+"/remote/agent",Rooms:[]string{"main"},MaxRole:"admin",EnableWebRTC:true}
	f.agent,err=NewAgent(dcfg,AgentBackend{Hub:f.h,ClientToken:"fixture-client",Manager:f.manager});if err!=nil{t.Fatal(err)};f.agent.Start(ctx)
	t.Cleanup(func(){f.agent.Close();cancel();wait,stop:=context.WithTimeout(context.Background(),5*time.Second);defer stop();if err:=f.agent.Wait(wait);err!=nil{t.Error(err)};f.cloud.Close();f.server.Close();f.h.Close()})
	eventually(t,func()bool{f.cloud.mu.Lock();defer f.cloud.mu.Unlock();a:=f.cloud.agents["office"];return a!=nil&&a.ready})
	return f
}
func(f *integration)native(t *testing.T,id string,m protocol.Object){t.Helper();b,err:=protocol.EncodeWire(m);if err!=nil{t.Fatal(err)};if err=f.h.Handle(f.connections[id],b);err!=nil{t.Fatal(err)}}
type testBrowser struct{t *testing.T; conn *websocket.Conn; opened Frame}
func(f *integration)connect(t *testing.T,role,mode string)*testBrowser{
	t.Helper();header:=http.Header{"Origin":[]string{f.cfg.PublicOrigin}}
	conn,_,err:=websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL,"http")+"/remote/connect",header);if err!=nil{t.Fatal(err)};t.Cleanup(func(){_ = conn.Close()})
	b:=&testBrowser{t:t,conn:conn};b.send(Frame{Type:"connect",Token:f.keys[role],DeviceID:"office",Room:"main",Mode:mode,PeerID:"fixture-browser"});b.opened=b.outer("opened");return b
}
func(b *testBrowser)send(f Frame){b.t.Helper();_ = b.conn.SetWriteDeadline(time.Now().Add(5*time.Second));if err:=b.conn.WriteJSON(f);err!=nil{b.t.Fatal(err)}}
func(b *testBrowser)outer(kind string)Frame{b.t.Helper();for i:=0;i<300;i++{_ = b.conn.SetReadDeadline(time.Now().Add(5*time.Second));var f Frame;if err:=b.conn.ReadJSON(&f);err!=nil{b.t.Fatal("read",kind,err)};if f.Type==kind{return f}};b.t.Fatal("frame limit waiting for",kind);return Frame{}}
func(b *testBrowser)payload(v any){raw,err:=json.Marshal(v);if err!=nil{b.t.Fatal(err)};b.send(Frame{Type:"data",ID:b.opened.ID,Payload:raw})}
func(b *testBrowser)message(kind,id string)map[string]any{b.t.Helper();for i:=0;i<300;i++{f:=b.outer("data");var m map[string]any;if err:=json.Unmarshal(f.Payload,&m);err!=nil{b.t.Fatal(err)};if m["type"]==kind&&(id==""||m["requestId"]==id){return m}};b.t.Fatal("message limit",kind);return nil}
func(b *testBrowser)relay(){b.send(Frame{Type:"select",ID:b.opened.ID,Mode:"relay"});if b.outer("selected").Mode!="relay"{b.t.Fatal("wrong transport")};b.payload(map[string]any{"type":"hello","protocolVersion":1,"peerRole":"client","peerId":"browser","roomId":"main","token":"remote-session"});b.message("welcome","");status:=b.message("host_status","");if len(status["hosts"].([]any))!=2{b.t.Fatal("multiple Pi hosts missing")};b.message("remote.presence","")}
func prompt(id,host string)map[string]any{return map[string]any{"type":"command","requestId":id,"targetHostId":host,"expectedStreamId":"stream-"+host,"expectedSessionId":"session-"+host,"expectedCwd":"/fixture/project","payload":map[string]any{"name":"prompt","content":"synthetic test only"}}}
func control(id,host,action string,force bool)map[string]any{return map[string]any{"type":"remote.control","requestId":id,"hostId":host,"action":action,"force":force}}
func TestCloudDeviceMultiUserPermissions(t *testing.T){
	f:=fixture(t);viewer:=f.connect(t,"viewer","relay");viewer.relay();operator:=f.connect(t,"operator","relay");operator.relay();admin:=f.connect(t,"admin","relay");admin.relay()
	viewer.payload(prompt("denied-viewer","pi-a"));if got:=viewer.message("command_result","denied-viewer");got["code"]!="READ_ONLY"{t.Fatal(got)}
	operator.payload(prompt("need-control","pi-a"));if got:=operator.message("command_result","need-control");got["code"]!="CONTROL_REQUIRED"{t.Fatal(got)}
	operator.payload(control("take","pi-a","acquire",false));if got:=operator.message("remote.result","take");got["ok"]!=true{t.Fatal(got)}
	admin.payload(control("busy","pi-a","acquire",false));if got:=admin.message("remote.result","busy");got["code"]!="CONTROL_BUSY"{t.Fatal(got)}
	operator.payload(prompt("once","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1})
	routed:=f.host["pi-a"].last("routed_command");f.native(t,"pi-a",protocol.Object{"type":"host_command_result","relayRequestId":routed["relayRequestId"],"status":"dispatched","code":nil,"message":nil})
	if got:=operator.message("command_result","once");got["status"]!="dispatched"{t.Fatal(got)}
	if f.host["pi-b"].count("routed_command")!=0{t.Fatal("write crossed Pi instance")}
	admin.payload(control("takeover","pi-a","acquire",true));if got:=admin.message("remote.result","takeover");got["ok"]!=true{t.Fatal(got)}
	operator.payload(prompt("old-lease","pi-a"));if got:=operator.message("command_result","old-lease");got["code"]!="CONTROL_REQUIRED"{t.Fatal(got)}
	for _,b:=range []*testBrowser{viewer,operator}{b.payload(map[string]any{"type":"remote.workspace","requestId":"no-create","request":map[string]any{"room":"main","operation":"create","id":"be650681-7b39-4f69-ae1b-0718fd793bfc","projectId":"fixture","name":"Fixture"}});if got:=b.message("remote.result","no-create");got["code"]!="FORBIDDEN"{t.Fatal(got)}}
	admin.payload(map[string]any{"type":"remote.workspace","requestId":"list","request":map[string]any{"room":"main","operation":"list"}});if got:=admin.message("remote.result","list");got["ok"]!=true{t.Fatal(got)}
	f.manager.mu.Lock();calls:=len(f.manager.calls);f.manager.mu.Unlock();if calls!=1{t.Fatal("unauthorized request reached local manager")}
	if f.host["pi-a"].count("routed_command")!=1{t.Fatal("duplicate/unauthorized write dispatched")}
	// A late close acknowledgement for this viewer must not disconnect every
	// collaborator or replace the office gateway connection.
	_ = viewer.conn.Close();eventually(t,func()bool{f.cloud.mu.Lock();defer f.cloud.mu.Unlock();return len(f.cloud.peers)==2})
	admin.payload(control("still-connected","pi-a","renew",false));if got:=admin.message("remote.result","still-connected");got["ok"]!=true{t.Fatal(got)}
	if !f.agent.Online(){t.Fatal("one browser disconnected office gateway")}
}
func TestHTTPDiscoveryAndRevocation(t *testing.T){
	f:=fixture(t)
	request:=func(origin,token string) (int,string){req,_:=http.NewRequest("POST",f.server.URL+"/api/remote/devices",strings.NewReader("{}"));req.Header.Set("Origin",origin);req.Header.Set("Authorization","Bearer "+token);resp,err:=http.DefaultClient.Do(req);if err!=nil{t.Fatal(err)};defer resp.Body.Close();b,_:=io.ReadAll(resp.Body);return resp.StatusCode,string(b)}
	if status,_:=request("https://evil.example",f.keys["viewer"]);status!=403{t.Fatal("foreign Origin",status)}
	if status,_:=request(f.cfg.PublicOrigin,testDeviceToken);status!=401{t.Fatal("device key accessed user inventory",status)}
	status,body:=request(f.cfg.PublicOrigin,f.keys["viewer"]);if status!=200||!strings.Contains(body,"office")||strings.Contains(body,"tokenHash"){t.Fatal(status,body)}
	b:=f.connect(t,"operator","relay");b.relay();b.payload(control("lease","pi-a","acquire",false));b.message("remote.result","lease")
	copyBytes,_:=json.Marshal(f.cfg);var revoked Config;_ = json.Unmarshal(copyBytes,&revoked);for i:=range revoked.Users{if revoked.Users[i].ID=="operator"{revoked.Users[i].Disabled=true}}
	if err:=f.cloud.Reload(revoked);err!=nil{t.Fatal(err)}
	eventually(t,func()bool{f.agent.control.mu.Lock();defer f.agent.control.mu.Unlock();return len(f.agent.control.peers)==0&&len(f.agent.control.leases)==0})
	if !f.agent.Online(){t.Fatal("revoking one user stopped office agent")}
}
func TestWebRTCFallbackBeforeBusinessOnly(t *testing.T){
	f:=fixture(t);b:=f.connect(t,"operator","auto")
	b.send(Frame{Type:"offer",ID:b.opened.ID,SDP:"not an SDP"});b.outer("signal_error");b.relay()
	b.payload(control("take","pi-a","acquire",false));b.message("remote.result","take")
	// Switching an established route is refused instead of replaying commands.
	b.send(Frame{Type:"select",ID:b.opened.ID,Mode:"webrtc"})
	eventually(t,func()bool{f.cloud.mu.Lock();defer f.cloud.mu.Unlock();return len(f.cloud.peers)==0})
	if f.host["pi-a"].count("routed_command")!=0{t.Fatal("fallback fabricated a write")}
}
