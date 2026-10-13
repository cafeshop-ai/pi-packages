package remote

import (
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
)

var requestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var readCommands = map[string]bool{"list_dir":true,"read_file":true,"list_sessions":true,"get_session":true,"list_commands":true}

type remoteSession struct {
	trace *rtcAttempt
	pendingSelection string
	roomKey, browserNonce string
	roomRevision uint64
	roomVerified, roomAttempted bool
	roomVerifiedAt time.Time
	accountSubject, accountSession, accountPublicKey string
	accountUntil, accountChecked time.Time
	agent *Agent
	link *wsLink
	identity Identity
	mode string
	ice []ICEServer
	mu sync.Mutex
	closed bool
	chosen string
	created, selectedAt, authorizedUntil time.Time
	connection *hub.Connection
	rtc *rtcPeer
	offered bool
	in,out chan []byte
	inBytes,outBytes,inCount,outCount int
	stop,selected chan struct{}
	authenticated atomic.Bool
	hosts map[string]bool
}
func newRemoteSession(a *Agent,l *wsLink,p Identity,mode string,ice []ICEServer)*remoteSession{
	var trace *rtcAttempt;if a!=nil&&a.room!=nil{trace=a.rtcDiagnostics.begin();trace.add("session","created")}
	now:=time.Now();return &remoteSession{trace:trace,agent:a,link:l,identity:p,mode:mode,ice:ice,created:now,authorizedUntil:now.Add(45*time.Second),in:make(chan []byte,128),out:make(chan []byte,128),stop:make(chan struct{}),selected:make(chan struct{}),hosts:map[string]bool{}}
}
func(s *remoteSession) renew(){s.mu.Lock();s.authorizedUntil=time.Now().Add(45*time.Second);s.mu.Unlock()}
func(s *remoteSession) expired(now time.Time)bool{
 s.mu.Lock();defer s.mu.Unlock()
 handshakeStart:=s.selectedAt
 // Room password verification precedes hello; each stage has its own bounded deadline.
 if s.roomVerified { handshakeStart=s.roomVerifiedAt }
 return !s.accountUntil.IsZero()&&!now.Before(s.accountUntil)||now.After(s.authorizedUntil)||s.chosen==""&&now.Sub(s.created)>30*time.Second||s.chosen!=""&&!s.authenticated.Load()&&now.Sub(handshakeStart)>5*time.Second
}
func(s *remoteSession) isTransport(mode string)bool{s.mu.Lock();defer s.mu.Unlock();return !s.closed&&s.chosen==mode}
func(s *remoteSession) selectTransport(mode string)error{
 s.trace.add("selection","requested")
 s.mu.Lock()
 if s.closed||s.chosen!=""||s.pendingSelection!=""||(mode!="relay"&&mode!="webrtc")||s.mode=="webrtc"&&mode!="webrtc"{s.mu.Unlock();return errors.New("invalid transport selection")}
 if mode=="webrtc"&&s.rtc==nil{s.mu.Unlock();return errors.New("WebRTC channel not offered")}
 // The remote DCEP ACK can precede our OnDataChannel/OnOpen callbacks.
 // Queue only the selection intention. No traffic or Hub admission is enabled.
 s.pendingSelection=mode;s.mu.Unlock()
 return s.finishTransportSelection()
}
func(s *remoteSession) finishTransportSelection()error{
 s.mu.Lock()
 if s.closed{s.mu.Unlock();return errClosed}
 mode:=s.pendingSelection
 if mode==""{s.mu.Unlock();return nil}
 if mode=="webrtc"&&(s.rtc==nil||!s.rtc.ready()){s.mu.Unlock();return nil}
 s.chosen=mode;s.pendingSelection="";s.selectedAt=time.Now();rtc:=s.rtc;s.mu.Unlock()
 // Exactly one caller consumes pendingSelection. Keep acknowledgement before
 // starting the writer, and retain the original authentication gate.
 if err:=s.link.Send(Frame{Type:"selected",ID:s.identity.ID,Mode:mode});err!=nil{return err}
 s.trace.add("selection","selected");close(s.selected)
 if mode=="relay"&&rtc!=nil{rtc.close()}
 return nil
}
func(s *remoteSession) Send(b []byte)error{
	if len(b)==0||len(b)>protocol.MaxFrameBytes{return errors.New("remote business frame exceeds limit")}
	s.mu.Lock();if s.closed{s.mu.Unlock();return errClosed}
	if s.outCount>=128||s.outBytes+len(b)>1024*1024||!s.agent.budget.reserve(len(b)){s.mu.Unlock();s.Close(1013,"Remote client is too slow");return errCapacity}
	s.outCount++;s.outBytes+=len(b);s.out<-append([]byte(nil),b...);s.mu.Unlock();return nil
}
func(s *remoteSession) sendJSON(v any)error{b,err:=json.Marshal(v);if err!=nil{return err};return s.Send(b)}
func(s *remoteSession) input(b []byte)error{
	if len(b)==0||len(b)>protocol.MaxFrameBytes||!utf8.Valid(b){return errors.New("invalid remote business frame")}
	s.mu.Lock();if s.closed||s.chosen==""{s.mu.Unlock();return errClosed}
	if s.roomKey!=""&&!s.roomVerified&&len(b)>8192{s.mu.Unlock();return errors.New("unauthenticated room frame exceeds limit")}
	if s.inCount>=128||s.inBytes+len(b)>1024*1024||!s.agent.budget.reserve(len(b)){s.mu.Unlock();return errCapacity}
	s.inCount++;s.inBytes+=len(b);s.in<-append([]byte(nil),b...);s.mu.Unlock();return nil
}
func(s *remoteSession) release(n int,input bool){s.mu.Lock();if input{s.inCount--;s.inBytes-=n}else{s.outCount--;s.outBytes-=n};s.mu.Unlock();s.agent.budget.release(n)}
func(s *remoteSession) Close(code int,reason string){
	s.mu.Lock();if s.closed{s.mu.Unlock();return};s.closed=true;close(s.stop);conn,rtc:=s.connection,s.rtc;s.mu.Unlock()
	s.trace.add("close",rtcCloseClass(reason))
	if conn!=nil{s.agent.backend.Hub.Leave(conn)}
	if rtc!=nil{go rtc.close()}
	_ = s.link.Send(Frame{Type:"closed",ID:s.identity.ID,Code:"REMOTE_CLOSED"})
	s.agent.remove(s)
}
func(s *remoteSession) readPump(){
	defer func(){s.Close(1000,"Remote read stopped");for{select{case b:=<-s.in:s.release(len(b),true);default:return}}}()
	for{select{case<-s.stop:return;default:};select{case<-s.stop:return;case b:=<-s.in:err:=s.handle(b);s.release(len(b),true);if err!=nil{return}}}
}
func(s *remoteSession) writePump(){
	defer func(){s.Close(1000,"Remote write stopped");for{select{case b:=<-s.out:s.release(len(b),false);default:return}}}()
	select{case<-s.stop:return;case<-s.selected:}
	for{select{case<-s.stop:return;default:};select{case<-s.stop:return;case b:=<-s.out:
		s.rememberHosts(b);s.mu.Lock();mode,rtc:=s.chosen,s.rtc;s.mu.Unlock();var err error
		if mode=="webrtc"&&rtc!=nil{err=rtc.send(b)}else if mode=="relay"{err=s.link.Send(Frame{Type:"data",ID:s.identity.ID,Payload:b})}else{err=errClosed}
		s.release(len(b),false);if err!=nil{return}
	}}
}
func(s *remoteSession) rememberHosts(b []byte){
	var v struct{Type string `json:"type"`;Hosts []struct{HostID string `json:"hostId"`;Connected bool `json:"connected"`;Ready *bool `json:"ready"`} `json:"hosts"`}
	if json.Unmarshal(b,&v)!=nil||v.Type!="host_status"||len(v.Hosts)>64{return}
	s.mu.Lock();s.hosts=map[string]bool{};for _,h:=range v.Hosts{s.hosts[h.HostID]=h.Connected&&(h.Ready==nil||*h.Ready)};s.mu.Unlock()
}
func(s *remoteSession) handle(raw []byte)error{
	if s.roomKey!="" {
		s.mu.Lock();verified:=s.roomVerified;s.mu.Unlock()
		if !verified{return s.roomAuthentication(raw)}
		s.mu.Lock();accountExpired:=!s.accountUntil.IsZero()&&!time.Now().Before(s.accountUntil);s.mu.Unlock();if accountExpired{return errAccountIdentity}
		key,revision:=s.agent.room.snapshot();if key!=s.roomKey||revision!=s.roomRevision{return errors.New("room authorization changed")}
	}
	var tag struct{Type string `json:"type"`};if json.Unmarshal(raw,&tag)!=nil{return errors.New("invalid JSON")}
	if s.authenticated.Load(){switch tag.Type{case "room.account.renew":return s.renewAccount(raw);case "remote.control":return s.controlRequest(raw);case "remote.workspace":return s.workspaceRequest(raw)}}
	m,err:=protocol.DecodeWire(raw);if err!=nil{return err}
	if !s.authenticated.Load(){
		if m["type"]!="hello"||m["peerRole"]!="client"||m["roomId"]!=s.identity.Room{return errors.New("remote client hello required")}
		s.trace.add("handshake","HELLO_RECEIVED")
		m["token"]=s.agent.backend.ClientToken;m["peerId"]="remote-"+s.identity.ID
		raw,err=protocol.EncodeWire(m);if err!=nil{return err}
		if err=s.agent.backend.Hub.Handle(s.connection,raw);err!=nil{return err}
		if !s.connection.Authenticated(){return errors.New("local hello rejected")}
		s.mu.Lock()
		if s.closed { s.mu.Unlock(); return errClosed }
		if !s.agent.control.Join(s.identity) { s.mu.Unlock(); return errCapacity }
		s.authenticated.Store(true)
		s.mu.Unlock()
		s.trace.add("handshake","HELLO_ACCEPTED")
		s.agent.broadcastPresence();return nil
	}
	if m["type"]!="command"{return errors.New("only client commands are permitted")}
	payload,ok:=m["payload"].(protocol.Object);if !ok{return errors.New("invalid command payload")};name,_:=payload["name"].(string)
	if !readCommands[name]{
		s.agent.roomPolicyMu.RLock();defer s.agent.roomPolicyMu.RUnlock()
		host,_:=m["targetHostId"].(string);session,_:=m["expectedSessionId"].(string);cwd,_:=m["expectedCwd"].(string)
		code:=s.agent.control.CanWrite(s.identity,host);if host==""||session==""||cwd==""{code="CONTEXT_REQUIRED"}
		if code!=""{return s.rejectCommand(m,code)}
	}
	return s.agent.backend.Hub.Handle(s.connection,raw)
}
func(s *remoteSession) rejectCommand(m protocol.Object,code string)error{
	result:=protocol.Object{"type":"command_result","requestId":m["requestId"],"status":"rejected","code":code,"message":code};if host,ok:=m["targetHostId"].(string);ok{result["hostId"]=host};b,err:=protocol.EncodeWire(result);if err!=nil{return err};return s.Send(b)
}
type controlMessage struct{Type string `json:"type"`;RequestID string `json:"requestId"`;HostID string `json:"hostId"`;Action string `json:"action"`;Force bool `json:"force,omitempty"`;ApplicationID string `json:"applicationId,omitempty"`}
type workspaceMessage struct{Type string `json:"type"`;RequestID string `json:"requestId"`;Request managed.Request `json:"request"`}
type remoteResult struct{Type string `json:"type"`;RequestID string `json:"requestId"`;OK bool `json:"ok"`;Code string `json:"code,omitempty"`;Data any `json:"data,omitempty"`}
func(s *remoteSession) result(id,code string,data any)error{return s.sendJSON(remoteResult{Type:"remote.result",RequestID:id,OK:code=="",Code:code,Data:data})}
func(s *remoteSession) controlRequest(raw []byte)error{
	var q controlMessage;if len(raw)>4096||strictJSON(raw,&q)!=nil||!requestID.MatchString(q.RequestID){return errors.New("invalid control request")}
	s.agent.roomPolicyMu.RLock();defer s.agent.roomPolicyMu.RUnlock()
	if q.Action=="cancel" {
		if q.Force||q.ApplicationID==""{return s.result(q.RequestID,"INVALID_REQUEST",nil)}
		application,exists:=s.agent.control.Application(s.identity.Room,q.ApplicationID);if !exists||application.HostID!=q.HostID{return s.result(q.RequestID,"CONTROL_REQUEST_GONE",nil)}
		code:=s.agent.control.CancelApplication(s.identity,q.ApplicationID);err:=s.result(q.RequestID,code,nil);s.agent.broadcastPresence();return err
	}
	if q.ApplicationID!=""{return s.result(q.RequestID,"INVALID_REQUEST",nil)}
	s.mu.Lock();available:=s.hosts[q.HostID];s.mu.Unlock();if !available&&q.Action!="release"{return s.result(q.RequestID,"HOST_NOT_READY",nil)}
	code:=s.agent.control.Change(s.identity,q.HostID,q.Action,q.Force);err:=s.result(q.RequestID,code,nil);s.agent.broadcastPresence();return err
}
func(s *remoteSession) workspaceRequest(raw []byte)error{
	var q workspaceMessage;if len(raw)>4096||strictJSON(raw,&q)!=nil||!requestID.MatchString(q.RequestID){return errors.New("invalid workspace request")}
	if q.Request.Room!=s.identity.Room{return s.result(q.RequestID,"FORBIDDEN",nil)}
	s.agent.roomPolicyMu.RLock();defer s.agent.roomPolicyMu.RUnlock()
	if s.roomKey!=""&&q.Request.Operation!="list"&&s.agent.control.RoomMode(s.identity.Room)=="approval"{return s.result(q.RequestID,"LOCAL_OWNER_REQUIRED",nil)}
	if s.agent.backend.Manager==nil{return s.result(q.RequestID,"MANAGED_UNAVAILABLE",nil)}
	if s.roomKey!="" {
		if !s.agent.cfg.RoomManagement { return s.result(q.RequestID,"MANAGED_UNAVAILABLE",nil) }
		if s.identity.Role!="operator" || (q.Request.Operation!="list"&&q.Request.Operation!="create"&&q.Request.Operation!="open") { return s.result(q.RequestID,"FORBIDDEN",nil) }
	} else if q.Request.Operation!="list"&&s.identity.Role!="admin"{return s.result(q.RequestID,"FORBIDDEN",nil)}
	data,code:=s.agent.backend.Manager.Execute(q.Request)
	b,err:=json.Marshal(remoteResult{Type:"remote.result",RequestID:q.RequestID,OK:code=="",Code:code,Data:data});if err!=nil||len(b)>protocol.MaxFrameBytes{return s.result(q.RequestID,"RESULT_TOO_LARGE",nil)}
	return s.Send(b)
}
