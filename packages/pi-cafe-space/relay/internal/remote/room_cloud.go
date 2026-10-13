package remote

import (
 "net/http"
 "strings"
 "time"

 "github.com/gorilla/websocket"
)

type roomJoinBudget struct { window time.Time; starts int }
// Accessed only while Cloud.mu is held. One busy room cannot spend another's budget.
func(b *roomJoinBudget)admit(now time.Time)bool{if now.Sub(b.window)>time.Minute{b.window=now;b.starts=0};if b.starts>=120{return false};b.starts++;return true}
type cloudRoomHost struct { key string; link *wsLink; joins *roomJoinBudget }
type cloudRoomPeer struct { id,nonce string; host *cloudRoomHost; link *wsLink; offered,selected bool }

func(c *Cloud)roomEnabled()bool{cfg,ok:=c.snapshot();return ok&&cfg.RoomAccess&&cfg.EnableWebRTC}
func(c *Cloud)roomHost(w http.ResponseWriter,r *http.Request,cfg Config){
 if !cfg.RoomAccess||!cfg.EnableWebRTC{failHTTP(w,404,"ROOM_UNAVAILABLE");return}
 if r.Method!="GET"||r.Header.Get("Origin")!=""||r.Header.Get("Authorization")!=""{failHTTP(w,403,"ORIGIN_DENIED");return}
 if !websocket.IsWebSocketUpgrade(r){failHTTP(w,400,"WEBSOCKET_REQUIRED");return}
 authed,done,ok:=c.admit(r);if !ok{failHTTP(w,503,"CONNECTION_LIMIT");return};defer done()
 up:=websocket.Upgrader{HandshakeTimeout:5*time.Second,CheckOrigin:func(*http.Request)bool{return true}}
 conn,err:=up.Upgrade(w,r,nil);if err!=nil{return};l:=newWSLink(conn,&c.budget);if !c.track(l){l.Close();return};defer c.untrack(l)
 conn.SetReadLimit(4096);_ = conn.SetReadDeadline(time.Now().Add(5*time.Second))
 nonce,err:=NewToken();if err!=nil{return};if l.Send(Frame{Type:"room_challenge",Nonce:nonce})!=nil{return}
 first,err:=l.Read();if err!=nil||first.Type!="room_register"||first.Token!=""||first.ID!=""||len(first.Payload)!=0||first.SDP!=""||!roomVerify(first.RoomKey,first.Signature,"cafe-room-register-v1",strings.TrimSuffix(cfg.PublicOrigin,"/"),first.RoomKey,nonce){return}
 host:=&cloudRoomHost{key:first.RoomKey,link:l,joins:&roomJoinBudget{}}
 c.mu.Lock();if c.closing||!c.cfg.RoomAccess||!c.healthy||len(c.roomHosts)>=64&&c.roomHosts[host.key]==nil{c.mu.Unlock();return};old:=c.roomHosts[host.key];if old!=nil{host.joins=old.joins};c.roomHosts[host.key]=host;c.mu.Unlock()
 if old!=nil{old.link.Close()};authed();conn.SetReadLimit(maxOuterBytes)
 defer func(){c.mu.Lock();if c.roomHosts[host.key]==host{delete(c.roomHosts,host.key)};links:=[]*wsLink{};for _,p:=range c.roomPeers{if p.host==host{links=append(links,p.link)}};c.mu.Unlock();for _,l:=range links{l.Close()}}()
 if l.Send(Frame{Type:"room_registered",RoomKey:host.key})!=nil{return}
 for{
  f,err:=l.Read();if err!=nil{return};if f.Token!=""||len(f.Payload)>0{return}
  c.mu.Lock();p:=c.roomPeers[f.ID];valid:=p!=nil&&p.host==host
  if valid&&f.Type=="selected"{if p.selected||f.Mode!="webrtc"{valid=false}else{p.selected=true}}
  c.mu.Unlock();if p==nil{continue};if !valid{return}
  switch f.Type{
  case "answer":
   if len(f.SDP)==0||!roomVerify(host.key,f.Signature,"cafe-room-answer-v1",host.key,p.id,p.nonce,f.PeerID,roomDigest(f.SDP)){return}
   _ = p.link.Send(Frame{Type:"answer",ID:p.id,SDP:f.SDP,Signature:f.Signature,PeerID:f.PeerID})
  case "selected":_ = p.link.Send(Frame{Type:"selected",ID:p.id,Mode:"webrtc"})
  case "signal_error":_ = p.link.Send(Frame{Type:"signal_error",ID:p.id,Code:"WEBRTC_UNAVAILABLE"})
  case "closed":p.link.Close()
  default:return
  }
 }
}
func(c *Cloud)roomBrowser(w http.ResponseWriter,r *http.Request,cfg Config){
 if !cfg.RoomAccess||!cfg.EnableWebRTC{failHTTP(w,404,"ROOM_UNAVAILABLE");return}
 if r.Method!="GET"||!originMatches(r,cfg)||r.Header.Get("Authorization")!=""{failHTTP(w,403,"ORIGIN_DENIED");return}
 if !websocket.IsWebSocketUpgrade(r){failHTTP(w,400,"WEBSOCKET_REQUIRED");return}
 authed,done,ok:=c.admit(r);if !ok{failHTTP(w,503,"CONNECTION_LIMIT");return};defer done()
 up:=websocket.Upgrader{HandshakeTimeout:5*time.Second,CheckOrigin:func(*http.Request)bool{return true}}
 conn,err:=up.Upgrade(w,r,nil);if err!=nil{return};l:=newWSLink(conn,&c.budget);if !c.track(l){l.Close();return};defer c.untrack(l)
 conn.SetReadLimit(4096);_ = conn.SetReadDeadline(time.Now().Add(5*time.Second))
 first,err:=l.Read();if err!=nil||first.Type!="room_connect"||first.Token!=""||first.ID!=""||first.SDP!=""||len(first.Payload)>0||!tokenPattern.MatchString(first.Nonce){return}
 if _,err=roomPublicKey(first.RoomKey);err!=nil{return};id,err:=NewToken();if err!=nil{return}
 c.mu.Lock();host:=c.roomHosts[first.RoomKey];count:=0;for _,p:=range c.roomPeers{if p.host==host{count++}}
 if c.closing||!c.healthy||!c.cfg.RoomAccess||host==nil||len(c.roomPeers)>=MaxPeers||count>=MaxDevicePeers{
  c.mu.Unlock();_ = conn.WriteControl(websocket.CloseMessage,websocket.FormatCloseMessage(4004,"Room is offline or unavailable"),time.Now().Add(time.Second));return
 }
 if !host.joins.admit(time.Now()){c.mu.Unlock();_ = conn.WriteControl(websocket.CloseMessage,websocket.FormatCloseMessage(4008,"Room temporarily busy"),time.Now().Add(time.Second));return}
 peer:=&cloudRoomPeer{id:id,nonce:first.Nonce,host:host,link:l};c.roomPeers[id]=peer;c.mu.Unlock();authed();conn.SetReadLimit(maxOuterBytes)
 defer func(){c.mu.Lock();delete(c.roomPeers,id);c.mu.Unlock();_ = host.link.Send(Frame{Type:"close",ID:id})}()
 ice:=c.iceServers("room-"+id[:16])
 if host.link.Send(Frame{Type:"room_open",ID:id,RoomKey:host.key,Nonce:peer.nonce,ICEServers:ice})!=nil{return}
 if l.Send(Frame{Type:"room_opened",ID:id,RoomKey:host.key,Nonce:peer.nonce,ICEServers:ice,WebRTC:true})!=nil{return}
 for{
  f,err:=l.Read();if err!=nil{return};if f.ID!=id||f.Token!=""||len(f.Payload)>0||f.RoomKey!=""||f.Nonce!=""||f.Signature!=""||f.Role!=""||f.UserID!=""||len(f.ICEServers)>0{return}
  c.mu.Lock();allowed:=!peer.selected
  if f.Type=="offer"{allowed=allowed&&!peer.offered;peer.offered=true}
  c.mu.Unlock();if !allowed{return}
  switch f.Type{
  case "offer":if len(f.SDP)==0||f.Mode!=""{return};if host.link.Send(Frame{Type:"offer",ID:id,SDP:f.SDP})!=nil{return}
  case "select":if f.Mode!="webrtc"||f.SDP!=""{return};if host.link.Send(Frame{Type:"select",ID:id,Mode:"webrtc"})!=nil{return}
  default:return
  }
 }
}
