package remote

import (
 "crypto/subtle"
 "crypto/tls"
 "errors"
 "io"
 "mime"
 "net"
 "net/http"
 "strings"
 "time"

 "github.com/gorilla/websocket"
)

func(a *Agent)runRoom(){
 backoff:=time.Second
 for a.ctx.Err()==nil{
  dialer:=websocket.Dialer{HandshakeTimeout:10*time.Second,EnableCompression:false,TLSClientConfig:&tls.Config{MinVersion:tls.VersionTLS12}}
  conn,response,err:=dialer.DialContext(a.ctx,a.cfg.CloudURL,nil)
  if response!=nil&&response.Body!=nil{_ = response.Body.Close()}
  if err==nil{
   l:=newWSLink(conn,&a.budget);key,_:=a.room.snapshot()
   _ = conn.SetReadDeadline(time.Now().Add(5*time.Second))
   challenge,e:=l.Read()
   if e==nil&&challenge.Type=="room_challenge"&&tokenPattern.MatchString(challenge.Nonce){
    signature,e:=a.room.sign(key,"cafe-room-register-v1",strings.TrimSuffix(a.cfg.PublicOrigin,"/"),key,challenge.Nonce)
    if e==nil&&l.Send(Frame{Type:"room_register",RoomKey:key,Signature:signature})==nil{
     registered,e:=l.Read()
     if e==nil&&registered.Type=="room_registered"&&registered.RoomKey==key{
      a.mu.Lock();if a.ctx.Err()==nil{a.link=l};a.mu.Unlock();backoff=time.Second
      a.readRoomLink(l,key)
     }
    }
   }
   l.Close();a.mu.Lock();if a.link==l{a.link=nil};peers:=[]*remoteSession{};for _,s:=range a.sessions{if s.link==l{peers=append(peers,s)}};a.mu.Unlock()
   for _,s:=range peers{s.Close(1001,"Room signaling disconnected")}
  }
  timer:=time.NewTimer(backoff);select{case<-a.ctx.Done():timer.Stop();return;case<-timer.C:};if backoff<15*time.Second{backoff*=2;if backoff>15*time.Second{backoff=15*time.Second}}
 }
}
func(a *Agent)readRoomLink(l *wsLink,key string){
 for{
  f,err:=l.Read();if err!=nil{return};if f.Token!=""||!tokenPattern.MatchString(f.ID)||len(f.Payload)>0{return}
  if f.Type=="room_open"{if a.openRoomGuest(l,f,key)!=nil{_ = l.Send(Frame{Type:"closed",ID:f.ID,Code:"ROOM_UNAVAILABLE"})};continue}
  a.mu.Lock();s:=a.sessions[f.ID];a.mu.Unlock();if s==nil||s.link!=l||s.roomKey!=key{continue}
  switch f.Type{
  case "renew":s.renew()
  case "close":s.Close(1000,"Visitor disconnected")
  case "offer":s.offer(f.SDP)
  case "select":if f.Mode!="webrtc"||s.selectTransport(f.Mode)!=nil{s.Close(1008,"P2P transport required")}
  default:return
  }
 }
}
func(a *Agent)openRoomGuest(l *wsLink,f Frame,registeredKey string)error{
 key,revision:=a.room.snapshot()
 if f.RoomKey!=key||key!=registeredKey||!tokenPattern.MatchString(f.Nonce)||f.Role!=""||f.UserID!=""||f.SDP!=""{return errors.New("invalid room invitation")}
 s:=newRemoteSession(a,l,Identity{ID:f.ID,UserID:"guest-"+f.ID,Name:"Guest "+f.ID[:6],Room:"main",Role:"operator"},"webrtc",f.ICEServers)
 s.roomKey=key;s.roomRevision=revision;s.browserNonce=f.Nonce
 a.mu.Lock();if a.ctx.Err()!=nil||a.link!=l||len(a.sessions)>=MaxDevicePeers||a.sessions[f.ID]!=nil{a.mu.Unlock();return errCapacity};a.sessions[f.ID]=s;a.mu.Unlock()
 // Do not join the business hub, enumerate hosts, or publish presence yet.
 go s.readPump();go s.writePump();return nil
}
func(s *remoteSession)roomAuthentication(raw []byte)error{
 var q struct{Type string `json:"type"`;ID string `json:"id"`;Nonce string `json:"nonce"`;Password string `json:"password"`;Nickname string `json:"nickname,omitempty"`;Visitor *visitorProof `json:"visitor,omitempty"`;Account string `json:"account,omitempty"`}
 if len(raw)>8192||strictJSON(raw,&q)!=nil||q.Account==""&&len(raw)>2048||q.Type!="room.auth"||q.ID!=s.identity.ID||q.Nonce!=s.browserNonce{return errors.New("room authentication required")}
 s.mu.Lock();if s.closed||s.roomAttempted{s.mu.Unlock();return errors.New("one password attempt per connection")};s.roomAttempted=true;s.mu.Unlock()
 if result:=s.agent.room.verifyResult(q.Password,s.roomKey,s.roomRevision);result.Code!=""{
  q.Password="";denied:=map[string]any{"type":"room.denied","code":result.Code}
  if result.RetryAfterSeconds>0{denied["retryAfterSeconds"]=result.RetryAfterSeconds}
  _ = s.sendJSON(denied)
  time.AfterFunc(250*time.Millisecond,func(){s.Close(1008,"Room authentication not completed")});return nil
 }
 q.Password=""
 identity,verifyErr:=verifiedRoomVisitor(s.identity,s.roomKey,s.browserNonce,q.Nickname,q.Visitor);if verifyErr!=nil{return verifyErr}
 var account accountClaims
 if q.Account!="" {
  if q.Visitor==nil{return errAccountIdentity}
  account,verifyErr=s.agent.accounts.verify(s.agent.ctx,q.Account,s.roomKey,s.identity.ID,s.browserNonce,q.Visitor.PublicKey)
  if verifyErr!=nil||account.Name!=q.Nickname {q.Account="";_ = s.sendJSON(map[string]any{"type":"room.denied","code":"ROOM_ACCOUNT_IDENTITY_FAILED"});time.AfterFunc(250*time.Millisecond,func(){s.Close(1008,"Account identity rejected")});return nil}
  identity=accountIdentity(identity,account,s.roomKey)
 }
 q.Account=""
 connection,err:=s.agent.backend.Hub.Join(s,"room-guest:"+s.identity.ID);if err!=nil{return err}
 s.mu.Lock();if s.closed{s.mu.Unlock();s.agent.backend.Hub.Leave(connection);return errClosed};s.connection=connection;s.identity=identity;if account.Subject!=""{s.accountSubject=account.Subject;s.accountSession=account.Session;s.accountPublicKey=account.PublicKey;s.accountUntil=time.Unix(account.Expires,0);s.accountChecked=time.Now()};s.roomVerified=true;s.roomVerifiedAt=time.Now();s.mu.Unlock()
 s.trace.add("handshake","ROOM_VERIFIED")
 return s.sendJSON(map[string]any{"type":"room.authenticated","id":s.identity.ID,"roomKey":s.roomKey,"deviceId":"room","roomId":"main","userId":s.identity.UserID,"visitorName":s.identity.Name,"identityKind":s.identity.Kind,"accountId":s.identity.AccountID,"name":s.agent.cfg.DeviceName,"role":s.identity.Role,"managed":s.agent.cfg.RoomManagement&&s.agent.backend.Manager!=nil})
}
func(a *Agent)invalidateRoom(){
 a.mu.Lock();link:=a.link;peers:=make([]*remoteSession,0,len(a.sessions));for _,s:=range a.sessions{peers=append(peers,s)};a.mu.Unlock()
 for _,s:=range peers{s.Close(1008,"Room access changed")};a.control.ForgetRoomApprovals("main");if link!=nil{link.Close()}
}
func(a *Agent)WrapRoomLocal(next http.Handler)http.Handler{
 if a.room==nil{return next}
 return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if r.URL.Path!="/api/room/terminal-owner"&&r.URL.Path!="/api/room/share"&&r.URL.Path!="/api/room/control"&&r.URL.Path!="/api/room/terminal"&&r.URL.Path!="/api/config"{next.ServeHTTP(w,r);return}
  remoteHeaders(w)
  if r.URL.RawPath!=""||r.URL.RawQuery!=""||r.URL.EscapedPath()!=r.URL.Path{failHTTP(w,400,"INVALID_REQUEST");return}
  if r.URL.Path=="/api/room/terminal"{a.roomTerminal(w,r);return}
  if r.URL.Path=="/api/room/control"{a.roomOwnerControl(w,r);return}
  if r.URL.Path=="/api/room/terminal-owner"{a.roomTerminalOwner(w,r);return}
  if r.URL.Path=="/api/config"{
   if r.Method!="GET"&&r.Method!="HEAD"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return};if r.Method=="HEAD"{w.WriteHeader(200);return}
   reply(w,200,map[string]any{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main","managedSessions":a.backend.Manager!=nil,"roomShare":true,"roomControl":true,"terminalShare":true,"terminalOwnerControl":true});return
  }
  if r.Method!="POST"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return}
  peer,_,err:=net.SplitHostPort(r.RemoteAddr);ip:=net.ParseIP(peer);host,_,hostErr:=net.SplitHostPort(r.Host)
  if err!=nil||ip==nil||!ip.IsLoopback()||hostErr!=nil||(host!="localhost"&&host!="127.0.0.1"&&host!="::1")||len(r.Header.Values("Origin"))!=1||r.Header.Get("Origin")!="http://"+r.Host||r.Header.Get("X-Cafe-Room")!="1"{failHTTP(w,403,"LOCAL_OWNER_REQUIRED");return}
  media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type"));if err!=nil||media!="application/json"{failHTTP(w,415,"JSON_REQUIRED");return}
  raw,err:=io.ReadAll(http.MaxBytesReader(w,r.Body,4096));if err!=nil{failHTTP(w,413,"REQUEST_TOO_LARGE");return}
  var q struct{Token string `json:"token"`;Operation string `json:"operation"`;Password string `json:"password,omitempty"`;ConfirmPassword string `json:"confirmPassword,omitempty"`;Revision uint64 `json:"revision,omitempty"`}
  if strictJSON(raw,&q)!=nil{failHTTP(w,400,"INVALID_REQUEST");return}
  if subtle.ConstantTimeCompare([]byte(q.Token),[]byte(a.backend.ClientToken))!=1{failHTTP(w,401,"UNAUTHORIZED");return};q.Token=""
  switch q.Operation{
  case "status":if q.Password!=""||q.ConfirmPassword!=""||q.Revision!=0{failHTTP(w,400,"INVALID_REQUEST");return}
  case "password","reset-link":
   if q.Operation=="password"&&(!RoomPasswordValid(q.Password)||q.Password!=q.ConfirmPassword){failHTTP(w,400,"INVALID_PASSWORD");return}
   if q.Operation=="reset-link"&&(q.Password!=""||q.ConfirmPassword!=""){failHTTP(w,400,"INVALID_REQUEST");return}
   if err=a.room.change(q.Password,q.Operation=="reset-link",q.Revision);err!=nil{failHTTP(w,409,"ROOM_CHANGED");return};a.invalidateRoom()
  default:failHTTP(w,400,"INVALID_REQUEST");return
  }
  key,revision:=a.room.snapshot()
  reply(w,200,map[string]any{"roomKey":key,"url":strings.TrimSuffix(a.cfg.PublicOrigin,"/")+"/#/room/"+key,"name":a.cfg.DeviceName,"online":a.Online(),"revision":revision,"passwordMinimum":6,"passwordMaximum":20,"visitorRole":"operator"})
 })
}
