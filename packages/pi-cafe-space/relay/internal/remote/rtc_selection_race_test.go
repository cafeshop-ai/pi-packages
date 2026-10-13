package remote

import (
 "encoding/json"
 "net/http"
 "strings"
 "sync"
 "testing"
 "time"
 "github.com/gorilla/websocket"
 "github.com/pion/webrtc/v4"
)

// The DCEP ACK is sent by pion/datachannel before pion/webrtc finishes its
// OnDataChannel callback and marks the receiver-side DataChannel open.
// A browser can legitimately send select during that interval.
func TestRoomSelectBeforeOfficeChannelReady(t *testing.T){
 for _,holdBeforeRegistration:=range []bool{false,true}{
  name:="before-local-open";if holdBeforeRegistration{name="before-local-registration"}
  t.Run(name,func(t *testing.T){
   f:=roomFixture(t,false);key,_:=f.agent.room.snapshot();nonce,_:=NewToken()
   conn,_,err:=websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL,"http")+"/room/join",http.Header{"Origin":[]string{f.server.URL}});if err!=nil{t.Fatal(err)};defer conn.Close()
   b:=&testBrowser{t:t,conn:conn};b.send(Frame{Type:"room_connect",RoomKey:key,Nonce:nonce});b.opened=b.outer("room_opened")
   pc,err:=newRTCAPI().NewPeerConnection(rtcConfiguration(b.opened.ICEServers));if err!=nil{t.Fatal(err)};defer pc.Close()
   label:="pi-cafe-v1";ordered:=true;dc,err:=pc.CreateDataChannel(label,&webrtc.DataChannelInit{Protocol:&label,Ordered:&ordered});if err!=nil{t.Fatal(err)}
   opened:=make(chan struct{});var openedOnce sync.Once;dc.OnOpen(func(){openedOnce.Do(func(){close(opened)})})
   r:=&roomBrowser{t:t,b:b,pc:pc,dc:dc,incoming:make(chan map[string]any,128),nonce:nonce,key:key}
   var decoder chunkDecoder;var receiveMu sync.Mutex
   dc.OnMessage(func(m webrtc.DataChannelMessage){receiveMu.Lock();defer receiveMu.Unlock();raw,e:=decoder.push(m.Data,time.Now());if e!=nil||raw==nil{return};var value map[string]any;if json.Unmarshal(raw,&value)==nil{select{case r.incoming<-value:default:}}})
   offer,err:=pc.CreateOffer(nil);if err!=nil{t.Fatal(err)};complete:=webrtc.GatheringCompletePromise(pc);if pc.SetLocalDescription(offer)!=nil{t.Fatal("offer")};select{case<-complete:case<-time.After(5*time.Second):t.Fatal("gather")}
   text:=pc.LocalDescription().SDP;b.send(Frame{Type:"offer",ID:b.opened.ID,SDP:text});answer:=b.outer("answer")
   if !roomVerify(key,answer.Signature,"cafe-room-answer-v1",key,b.opened.ID,nonce,roomDigest(text),roomDigest(answer.SDP)){t.Fatal("invalid answer signature")}
   f.agent.mu.Lock();session:=f.agent.sessions[b.opened.ID];f.agent.mu.Unlock();if session==nil{t.Fatal("missing session")}
   session.mu.Lock();office:=session.rtc;session.mu.Unlock();if office==nil{t.Fatal("missing office peer")}
   entered:=make(chan struct{});release:=make(chan struct{});var releaseOnce sync.Once;unblock:=func(){releaseOnce.Do(func(){close(release)})};defer unblock()
   office.pc.OnDataChannel(func(d *webrtc.DataChannel){
    if holdBeforeRegistration{close(entered);<-release;session.acceptRTCDataChannel(office,d)}else{session.acceptRTCDataChannel(office,d);close(entered);<-release}
   })
   if pc.SetRemoteDescription(webrtc.SessionDescription{Type:webrtc.SDPTypeAnswer,SDP:answer.SDP})!=nil{t.Fatal("answer")}
   select{case<-entered:case<-time.After(5*time.Second):t.Fatal("receiver callback")};select{case<-opened:case<-time.After(5*time.Second):t.Fatal("DCEP client open")}
   if dc.ReadyState()!=webrtc.DataChannelStateOpen||office.ready(){t.Fatal("did not reproduce asymmetric readiness")}
   b.send(Frame{Type:"select",ID:b.opened.ID,Mode:"webrtc"})
   select{case<-session.stop:t.Fatal("valid browser-open select closed session before office OnDataChannel completed");case<-time.After(150*time.Millisecond):}
   session.mu.Lock();chosen:=session.chosen;joined:=session.connection!=nil;session.mu.Unlock()
   if chosen!=""||joined{t.Fatal("accepted business transport before local readiness/password")}
   if err:=session.selectTransport("webrtc");err==nil{t.Fatal("duplicate pending selection accepted")}
   if err:=session.selectTransport("relay");err==nil{t.Fatal("pending WebRTC selection downgraded")}
   if !session.expired(time.Now().Add(31*time.Second)){t.Fatal("pending selection disabled existing handshake expiry")}
   if err:=session.input([]byte(`{"type":"hello"}`));err==nil{t.Fatal("input accepted while selection pending")}
   select{case<-r.incoming:t.Fatal("pre-auth data leak");default:}
   // Pending selection must not block signaling for the other visitors.
   other:=connectRoom(t,f,false);other.authenticate("123456");other.receive("room.authenticated")
   unblock();b.outer("selected")
   if !office.ready(){t.Fatal("selected before receiver open")}
   r.authenticate("123456");r.receive("room.authenticated");r.hello()
   if dc.ReadyState()!=webrtc.DataChannelStateOpen{t.Fatal("channel did not survive selection")}
  })
 }
}
