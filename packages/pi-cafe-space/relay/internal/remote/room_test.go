package remote

import (
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "os"
 "path/filepath"
 "strings"
 "sync"
 "testing"
 "time"

 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
 "github.com/gorilla/websocket"
 "github.com/pion/webrtc/v4"
)

func TestRoomIdentityPasswordAndRotation(t *testing.T){
 path:=filepath.Join(t.TempDir(),"private","room.json");owner,err:=loadRoomOwner(path,"123456");if err!=nil{t.Fatal(err)}
 key,rev:=owner.snapshot();if len(key)!=87||rev!=1{t.Fatal("unstable room identity")}
 if !owner.verify("123456",key,rev)||owner.verify("654321",key,rev){t.Fatal("password verification")}
 before,err:=os.ReadFile(path);if err!=nil{t.Fatal(err)};if strings.Contains(string(before),"123456"){t.Fatal("plaintext password saved")}
 again,err:=loadRoomOwner(path,"different123");if err!=nil{t.Fatal(err)};same,r:=again.snapshot();if same!=key||r!=rev||!again.verify("123456",key,rev){t.Fatal("restart replaced credentials")}
 if owner.change("abcdef",false,rev)!=nil{t.Fatal("change password")};same,r=owner.snapshot();if same!=key||r!=rev+1||!owner.verify("abcdef",key,r)||owner.verify("123456",key,r){t.Fatal("password and URL independence")}
 if owner.change("",true,rev)==nil{t.Fatal("stale revision updated identity")}
 if owner.change("",true,r)!=nil{t.Fatal("reset link")};newKey,newRev:=owner.snapshot();if newKey==key||!owner.verify("abcdef",newKey,newRev)||owner.verify("abcdef",key,newRev){t.Fatal("key rotation")}
 if err=os.WriteFile(path,[]byte("broken"),0600);err!=nil{t.Fatal(err)};if _,err=loadRoomOwner(path,"123456");err==nil{t.Fatal("corrupt room reset silently")}
}
func TestRoomSignedTranscriptCannotBeReplayedOrSubstituted(t *testing.T){
 key,err:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if err!=nil{t.Fatal(err)};public:=roomKeyID(key);id,_:=NewToken();nonce,_:=NewToken();offer,answer:=roomDigest("offer"),roomDigest("answer")
 parts:=[]string{"cafe-room-answer-v1",public,id,nonce,offer,answer};signature,err:=roomSign(key,parts...);if err!=nil{t.Fatal(err)}
 if !roomVerify(public,signature,parts...){t.Fatal("signature rejected")}
 for i:=range parts{copy:=append([]string(nil),parts...);copy[i]+="changed";if roomVerify(public,signature,copy...){t.Fatal("signature accepted changed transcript",i)}}
 other,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if roomVerify(roomKeyID(other),signature,parts...){t.Fatal("another room identity accepted")}
}
func TestRoomGuessBudgetPersistsAcrossConnections(t *testing.T){
 owner,err:=loadRoomOwner(filepath.Join(t.TempDir(),"private","room.json"),"123456");if err!=nil{t.Fatal(err)};key,revision:=owner.snapshot()
 for i:=0;i<13;i++{if result:=owner.verifyResult("123456",key,revision);result.Code!=""{t.Fatal("normal joins hit old twelve-attempt lockout",result)}}
 if result:=owner.verifyResult("wrong1",key,revision);result.Code!="ROOM_PASSWORD_REJECTED"{t.Fatal(result)}
 owner.mu.Lock();owner.attempts=roomPasswordAttemptLimit;owner.window=time.Now();owner.mu.Unlock()
 result:=owner.verifyResult("123456",key,revision);if result.Code!="ROOM_AUTH_RATE_LIMITED"||result.RetryAfterSeconds<1||result.RetryAfterSeconds>60{t.Fatal("capacity was reported as a wrong password",result)}
 owner.mu.Lock();owner.window=time.Now().Add(-time.Minute-time.Second);owner.mu.Unlock()
 if !owner.verify("123456",key,revision){t.Fatal("resource budget failed to recover")}
 owner.mu.Lock();owner.verifying=true;attempts:=owner.attempts;owner.mu.Unlock()
 if result:=owner.verifyResult("123456",key,revision);result.Code!="ROOM_AUTH_BUSY"||result.RetryAfterSeconds!=1{t.Fatal(result)}
 owner.mu.Lock();owner.verifying=false;if owner.attempts!=attempts{t.Fatal("busy request consumed computation quota")};owner.mu.Unlock()
 if result:=owner.verifyResult("123456",key,revision+1);result.Code!="ROOM_ACCESS_CHANGED"{t.Fatal(result)}
}
func roomFixture(t *testing.T,turnOnly bool,managers ...ManagerPort)*integration{
 t.Helper();f:=&integration{host:map[string]*testHost{},connections:map[string]*hub.Connection{}}
 f.server=httptest.NewUnstartedServer(nil);f.cfg=Config{Mode:"cloud",PublicOrigin:"http://"+f.server.Listener.Addr().String(),RoomAccess:true,EnableWebRTC:true}
 if turnOnly{f.cfg.ICEServers=[]ICEServer{localTURN(t)}}
 var err error;f.cloud,err=NewCloud(f.cfg,"");if err!=nil{t.Fatal(err)};f.server.Config.Handler=f.cloud.Wrap(http.NotFoundHandler());f.server.Start()
 ctx,cancel:=context.WithCancel(context.Background());f.cloud.Start(ctx);f.h=hub.New(hub.Options{HostToken:"fixture-host",ClientToken:"123456"})
 for _,id:=range []string{"pi-a","pi-b"}{h:=&testHost{};c,err:=f.h.Join(h,"127.0.0.1");if err!=nil{t.Fatal(err)};f.host[id]=h;f.connections[id]=c
  f.native(t,id,protocol.Object{"type":"hello","protocolVersion":float64(1),"peerRole":"host","peerId":id,"roomId":"main","token":"fixture-host"})
  f.native(t,id,protocol.Object{"type":"snapshot","snapshot":protocol.Object{"protocolVersion":float64(1),"streamId":"stream-"+id,"sessionId":"session-"+id,"sessionName":id,"cwd":"/fixture/project","activeLeafId":nil,"model":nil,"thinkingLevel":"off","phase":"idle","hasPendingMessages":false,"messages":[]any{},"tools":[]any{},"historyTruncated":false,"lastEventSeq":float64(0)}})
 }
 cfg:=Config{Mode:"device",PublicOrigin:f.server.URL,CloudURL:"ws"+strings.TrimPrefix(f.server.URL,"http")+"/room/host",RoomIdentityFile:filepath.Join(t.TempDir(),"private","room.json"),DeviceName:"Office room",Rooms:[]string{"main"},MaxRole:"operator",EnableWebRTC:true}
 backend:=AgentBackend{Hub:f.h,ClientToken:"123456"};if len(managers)>0{cfg.RoomManagement=true;backend.Manager=managers[0]}
 f.agent,err=NewAgent(cfg,backend);if err!=nil{t.Fatal(err)};f.agent.Start(ctx)
 t.Cleanup(func(){f.agent.Close();cancel();wait,stop:=context.WithTimeout(context.Background(),5*time.Second);defer stop();if err:=f.agent.Wait(wait);err!=nil{t.Error(err)};f.cloud.Close();f.server.Close();f.h.Close()})
 eventually(t,func()bool{return f.agent.Online()});return f
}
type roomBrowser struct{t *testing.T;b *testBrowser;pc *webrtc.PeerConnection;dc *webrtc.DataChannel;incoming chan map[string]any;sequence uint32;nonce,key string}
func connectRoom(t *testing.T,f *integration,turnOnly bool)*roomBrowser{
 t.Helper();key,_:=f.agent.room.snapshot();nonce,_:=NewToken();conn,_,err:=websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL,"http")+"/room/join",http.Header{"Origin":[]string{f.server.URL}});if err!=nil{t.Fatal(err)};t.Cleanup(func(){conn.Close()})
 b:=&testBrowser{t:t,conn:conn};b.send(Frame{Type:"room_connect",RoomKey:key,Nonce:nonce});b.opened=b.outer("room_opened")
 configuration:=rtcConfiguration(b.opened.ICEServers);if turnOnly{configuration.ICETransportPolicy=webrtc.ICETransportPolicyRelay}
 pc,err:=newRTCAPI().NewPeerConnection(configuration);if err!=nil{t.Fatal(err)};t.Cleanup(func(){pc.Close()})
 name:="pi-cafe-v1";ordered:=true;dc,err:=pc.CreateDataChannel(name,&webrtc.DataChannelInit{Protocol:&name,Ordered:&ordered});if err!=nil{t.Fatal(err)}
 r:=&roomBrowser{t:t,b:b,pc:pc,dc:dc,incoming:make(chan map[string]any,128),nonce:nonce,key:key};opened:=make(chan struct{});var once sync.Once;dc.OnOpen(func(){once.Do(func(){close(opened)})})
 var decoder chunkDecoder;var mu sync.Mutex
 dc.OnMessage(func(m webrtc.DataChannelMessage){mu.Lock();defer mu.Unlock();raw,err:=decoder.push(m.Data,time.Now());if err!=nil||raw==nil{return};var value map[string]any;if json.Unmarshal(raw,&value)==nil{select{case r.incoming<-value:default:}}})
 offer,err:=pc.CreateOffer(nil);if err!=nil{t.Fatal(err)};gathered:=webrtc.GatheringCompletePromise(pc);if pc.SetLocalDescription(offer)!=nil{t.Fatal("offer")}
 select{case<-gathered:case<-time.After(8*time.Second):t.Fatal("offer gather")};text:=pc.LocalDescription().SDP;b.send(Frame{Type:"offer",ID:b.opened.ID,SDP:text});answer:=b.outer("answer")
 if answer.PeerID!=roomDigest(text)||!roomVerify(key,answer.Signature,"cafe-room-answer-v1",key,b.opened.ID,nonce,roomDigest(text),roomDigest(answer.SDP)){t.Fatal("office answer signature invalid")}
 if pc.SetRemoteDescription(webrtc.SessionDescription{Type:webrtc.SDPTypeAnswer,SDP:answer.SDP})!=nil{t.Fatal("answer")}
 select{case<-opened:case<-time.After(8*time.Second):t.Fatal("DataChannel open")};b.send(Frame{Type:"select",ID:b.opened.ID,Mode:"webrtc"});b.outer("selected")
 pair,err:=pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair();if err!=nil||pair==nil{t.Fatal("missing ICE pair")};if turnOnly&&pair.Local.Typ!=webrtc.ICECandidateTypeRelay{t.Fatal("forced TURN did not use TURN")}
 return r
}
func(r *roomBrowser)send(value any){r.t.Helper();raw,_:=json.Marshal(value);r.sequence++;for offset:=0;offset<len(raw);offset+=rtcPacketBytes-rtcHeaderBytes{if r.dc.Send(chunkPacket(r.sequence,raw,offset))!=nil{r.t.Fatal("send")}}}
func(r *roomBrowser)receive(kind string)map[string]any{r.t.Helper();deadline:=time.After(5*time.Second);for{select{case<-deadline:r.t.Fatal("room response timeout",kind);case m:=<-r.incoming:if m["type"]==kind{return m}}}}
func(r *roomBrowser)authenticate(password string){r.send(map[string]any{"type":"room.auth","id":r.b.opened.ID,"nonce":r.nonce,"password":password})}
func(r *roomBrowser)hello(){r.send(map[string]any{"type":"hello","protocolVersion":1,"peerRole":"client","peerId":"room-test-browser","roomId":"main","token":"remote-session"});r.receive("welcome");status:=r.receive("host_status");if len(status["hosts"].([]any))!=2{r.t.Fatal("room missing Pi instances")}}
func TestRoomEndToEndDirectAndTURN(t *testing.T){
 for _,turnOnly:=range []bool{false,true}{name:="direct";if turnOnly{name="turn"};t.Run(name,func(t *testing.T){
  f:=roomFixture(t,turnOnly);r:=connectRoom(t,f,turnOnly)
  f.agent.mu.Lock();s:=f.agent.sessions[r.b.opened.ID];f.agent.mu.Unlock();s.mu.Lock();hasConnection:=s.connection!=nil;s.mu.Unlock();if hasConnection{t.Fatal("joined Hub before password")}
  select{case<-r.incoming:t.Fatal("data leaked before password");case<-time.After(80*time.Millisecond):}
  r.authenticate("123456");info:=r.receive("room.authenticated");if info["role"]!="operator"||info["managed"]!=false{t.Fatal("guest escalated")};r.hello();r.receive("remote.presence")
  second:=connectRoom(t,f,turnOnly);second.authenticate("123456");second.receive("room.authenticated");second.hello();second.receive("remote.presence")
  r.send(control("take","pi-a","acquire",false));if r.receive("remote.result")["code"]!="CONTROL_DISABLED"{t.Fatal("default room unexpectedly created control lease")};if f.agent.control.RoomMode("main")!="disabled"{t.Fatal("room control not off by default")}
  second.send(control("takeover","pi-a","acquire",true));if second.receive("remote.result")["code"]!="FORBIDDEN"{t.Fatal("guest forced control")}
  r.send(prompt("once","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1});if f.host["pi-b"].count("routed_command")!=0{t.Fatal("cross-instance command")}
  key,rev:=f.agent.room.snapshot();if f.agent.room.change("abcdef",false,rev)!=nil{t.Fatal("password change")};f.agent.invalidateRoom();eventually(t,func()bool{return r.dc.ReadyState()==webrtc.DataChannelStateClosed})
  same,_:=f.agent.room.snapshot();if key!=same{t.Fatal("password change changed room URL")}
 })}
}
func TestRoomWrongPasswordAndPreAuthCommandsDoNotLeak(t *testing.T){
 f:=roomFixture(t,false);wrong:=connectRoom(t,f,false);wrong.authenticate("wrong1");m:=wrong.receive("room.denied");if m["code"]!="ROOM_PASSWORD_REJECTED"{t.Fatal(m)}
 eventually(t,func()bool{return wrong.dc.ReadyState()==webrtc.DataChannelStateClosed})
 preauth:=connectRoom(t,f,false);preauth.send(prompt("unauthorized","pi-a"));eventually(t,func()bool{return preauth.dc.ReadyState()==webrtc.DataChannelStateClosed})
 if f.host["pi-a"].count("routed_command")!=0{t.Fatal("preauth command executed")}
}
func TestRoomRegistrationCannotBeClaimedWithPublicKeyAlone(t *testing.T){
 f:=roomFixture(t,false);key,_:=f.agent.room.snapshot();conn,_,err:=websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL,"http")+"/room/host",nil);if err!=nil{t.Fatal(err)};defer conn.Close()
 var challenge Frame;_ = conn.ReadJSON(&challenge);_ = conn.WriteJSON(Frame{Type:"room_register",RoomKey:key,Signature:strings.Repeat("a",86)})
 _ = conn.SetReadDeadline(time.Now().Add(2*time.Second));if conn.ReadJSON(new(Frame))==nil{t.Fatal("room claimed without private key")}
 if !f.agent.Online(){t.Fatal("unauthorized registration disconnected owner")}
 req:=httptest.NewRequest("POST",f.server.URL+"/api/remote/devices",strings.NewReader("{}"));req.Header.Set("Origin",f.server.URL);w:=httptest.NewRecorder();f.cloud.Wrap(http.NotFoundHandler()).ServeHTTP(w,req);if w.Code!=404{t.Fatal("public site exposed device discovery")}
}
func TestRoomLocalShareHasNoSecretsAndRequiresOwner(t *testing.T){
 f:=roomFixture(t,false);handler:=f.agent.WrapRoomLocal(http.NotFoundHandler())
 request:=func(body,origin,peer string)*httptest.ResponseRecorder{r:=httptest.NewRequest("POST","http://127.0.0.1:37891/api/room/share",strings.NewReader(body));r.RemoteAddr=peer;r.Header.Set("Origin",origin);r.Header.Set("Content-Type","application/json");r.Header.Set("X-Cafe-Room","1");w:=httptest.NewRecorder();handler.ServeHTTP(w,r);return w}
 for _,q:=range []struct{body,origin,peer string}{{`{"operation":"status","token":"bad"}`,"http://127.0.0.1:37891","127.0.0.1:1234"},{`{"operation":"status","token":"123456"}`,"https://evil.invalid","127.0.0.1:1234"},{`{"operation":"status","token":"123456"}`,"http://127.0.0.1:37891","192.0.2.1:1234"}}{if w:=request(q.body,q.origin,q.peer);w.Code==200{t.Fatal("unauthorized local share")}}
 w:=request(`{"operation":"status","token":"123456"}`,"http://127.0.0.1:37891","127.0.0.1:1234");if w.Code!=200{t.Fatal(w.Code,w.Body.String())};var info map[string]any;_ = json.Unmarshal(w.Body.Bytes(),&info)
 key,_:=f.agent.room.snapshot();if info["url"]!=f.server.URL+"/#/room/"+key{t.Fatal("wrong share URL")};for _,secret:=range []string{"123456",f.agent.room.record.PrivateKey,f.agent.room.record.Verifier}{if strings.Contains(w.Body.String(),secret){t.Fatal("secret in share response")}}
}
