package remote

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"github.com/gorilla/websocket"
)

type ManagerPort interface { Execute(managed.Request)(any,string) }
type AgentBackend struct { Hub *hub.Hub; ClientToken string; HostToken string; Manager ManagerPort }

type Agent struct {
	accounts *accountVerifier
	roomPolicyMu sync.RWMutex
	roomControl *roomControlSettings
	rtcDiagnostics rtcDiagnostics
	room *roomOwner
	cfg Config
	backend AgentBackend
	ctx context.Context
	cancel context.CancelFunc
	mu sync.Mutex
	link *wsLink
	sessions map[string]*remoteSession
	control *coordinator
	budget byteBudget
	start sync.Once
	done chan struct{}
	started bool
}
func NewAgent(cfg Config,backend AgentBackend)(*Agent,error){
	if cfg.RoomManagement && backend.Manager==nil { return nil,errors.New("room process management requires an approved local manager configuration") }
	if err:=cfg.Validate();err!=nil{return nil,err};if cfg.Mode!="device"||backend.Hub==nil||backend.ClientToken==""{return nil,errors.New("device mode and local hub required")}
	var owner *roomOwner
	if cfg.RoomIdentityFile!=""{var err error;owner,err=loadRoomOwner(cfg.RoomIdentityFile,backend.ClientToken);if err!=nil{return nil,err}}
	control:=newCoordinator(time.Now)
	var settings *roomControlSettings
	if owner!=nil{var err error;settings,err=loadRoomControlSettings(cfg.RoomIdentityFile);if err!=nil{return nil,err};control.SetRoomPolicy("main",settings.snapshot().Enabled)}
	ctx,cancel:=context.WithCancel(context.Background())
	return &Agent{accounts:newAccountVerifier(cfg.AccountIssuer),roomControl:settings,room:owner,cfg:cfg,backend:backend,ctx:ctx,cancel:cancel,sessions:map[string]*remoteSession{},control:control,budget:byteBudget{limit:32*1024*1024},done:make(chan struct{})},nil
}
func(a *Agent) Start(parent context.Context){a.start.Do(func(){a.mu.Lock();a.started=true;a.mu.Unlock();go func(){select{case<-parent.Done():a.Close();case<-a.ctx.Done():}}();go a.maintain();go a.run()})}
func(a *Agent) Close(){
	if a.accounts!=nil{a.accounts.client.CloseIdleConnections()}
	a.cancel();a.mu.Lock();l:=a.link;peers:=make([]*remoteSession,0,len(a.sessions));for _,s:=range a.sessions{peers=append(peers,s)};a.mu.Unlock()
	if l!=nil{l.Close()};for _,s:=range peers{s.Close(1001,"Device connection closed")}
}
func(a *Agent) Wait(ctx context.Context)error{a.mu.Lock();started:=a.started;a.mu.Unlock();if !started{return nil};select{case<-a.done:return nil;case<-ctx.Done():return ctx.Err()}}
func(a *Agent) Online()bool{a.mu.Lock();defer a.mu.Unlock();return a.link!=nil&&a.ctx.Err()==nil}
func(a *Agent) run(){
	defer close(a.done)
	if a.room!=nil{a.runRoom();return}
	backoff:=time.Second
	for a.ctx.Err()==nil {
		dialer:=websocket.Dialer{HandshakeTimeout:10*time.Second,EnableCompression:false,TLSClientConfig:&tls.Config{MinVersion:tls.VersionTLS12}}
		headers:=http.Header{"Authorization":[]string{"Bearer "+a.cfg.DeviceToken},"X-Cafe-Device":[]string{a.cfg.DeviceID}}
		conn,response,err:=dialer.DialContext(a.ctx,a.cfg.CloudURL,headers)
		if response!=nil&&response.Body!=nil{_ = response.Body.Close()}
		if err==nil{
			l:=newWSLink(conn,&a.budget);a.mu.Lock();if a.ctx.Err()!=nil{a.mu.Unlock();l.Close();return};a.link=l;a.mu.Unlock()
			backoff=time.Second
			if l.Send(Frame{Type:"ready",WebRTC:a.cfg.EnableWebRTC,Managed:a.backend.Manager!=nil})==nil{a.readLink(l)}
			l.Close();a.mu.Lock();if a.link==l{a.link=nil};peers:=[]*remoteSession{};for _,s:=range a.sessions{if s.link==l{peers=append(peers,s)}};a.mu.Unlock();for _,s:=range peers{s.Close(1001,"Cloud connection lost")}
		}
		timer:=time.NewTimer(backoff);select{case<-a.ctx.Done():timer.Stop();return;case<-timer.C:};if backoff<15*time.Second{backoff*=2;if backoff>15*time.Second{backoff=15*time.Second}}
	}
}
func(a *Agent) readLink(l *wsLink){
	for {f,err:=l.Read();if err!=nil{return};if f.Token!=""||!tokenPattern.MatchString(f.ID){return}
		if f.Type=="open"{if err:=a.open(l,f);err!=nil{_ = l.Send(Frame{Type:"closed",ID:f.ID,Code:"REMOTE_ACCESS_DENIED"})};continue}
		a.mu.Lock();s:=a.sessions[f.ID];a.mu.Unlock();if s==nil||s.link!=l{continue}
		switch f.Type{
		case "renew":s.renew()
		case "close":s.Close(1000,"Browser disconnected")
		case "offer":s.offer(f.SDP)
		case "select":if err:=s.selectTransport(f.Mode);err!=nil{s.Close(1008,"Invalid transport selection")}
		case "data":if !s.isTransport("relay")||s.input(f.Payload)!=nil{s.Close(1008,"Invalid remote data")}
		default:return
		}
	}
}
func(a *Agent) open(l *wsLink,f Frame)error{
	if !identifier.MatchString(f.UserID)||!validName(f.Name)||!a.cfg.AllowsRoom(f.Room)||roleRank(f.Role)==0||(f.Mode!="auto"&&f.Mode!="relay"&&f.Mode!="webrtc")||len(f.Payload)!=0||f.SDP!=""{return errors.New("invalid remote grant")}
	role:=f.Role;if roleRank(role)>roleRank(a.cfg.MaxRole){role=a.cfg.MaxRole}
	if f.Mode=="webrtc"&&!a.cfg.EnableWebRTC{return errors.New("WebRTC disabled on device")}
	s:=newRemoteSession(a,l,Identity{ID:f.ID,UserID:f.UserID,Name:f.Name,Room:f.Room,Role:role},f.Mode,f.ICEServers)
	a.mu.Lock();if a.ctx.Err()!=nil||a.link!=l||len(a.sessions)>=MaxDevicePeers||a.sessions[f.ID]!=nil{a.mu.Unlock();return errCapacity};a.sessions[f.ID]=s;a.mu.Unlock()
	conn,err:=a.backend.Hub.Join(s,"remote:"+f.UserID)
	if err!=nil{s.Close(1013,"Local relay capacity exceeded");return err}
	s.mu.Lock();if s.closed{s.mu.Unlock();a.backend.Hub.Leave(conn);return errClosed};s.connection=conn;s.mu.Unlock()
	go s.readPump();go s.writePump()
	if err:=l.Send(Frame{Type:"opened",ID:s.identity.ID,Role:role,WebRTC:a.cfg.EnableWebRTC,Managed:a.backend.Manager!=nil});err!=nil{s.Close(1001,"Cloud connection lost");return err}
	return nil
}
func(a *Agent) remove(s *remoteSession){a.mu.Lock();if a.sessions[s.identity.ID]==s{delete(a.sessions,s.identity.ID)};a.mu.Unlock();a.control.Leave(s.identity.ID);a.broadcastPresence()}
func(a *Agent) broadcastPresence(){a.mu.Lock();peers:=make([]*remoteSession,0,len(a.sessions));for _,s:=range a.sessions{peers=append(peers,s)};a.mu.Unlock();for _,s:=range peers{if s.authenticated.Load(){_ = s.sendJSON(a.control.Snapshot(s.identity))}}}
func(a *Agent) maintain(){ticker:=time.NewTicker(time.Second);defer ticker.Stop();for{select{case<-a.ctx.Done():return;case now:=<-ticker.C:
	a.mu.Lock();peers:=make([]*remoteSession,0,len(a.sessions));for _,s:=range a.sessions{peers=append(peers,s)};a.mu.Unlock()
	a.rtcDiagnostics.prune(now)
	for _,s:=range peers{if s.expired(now){s.Close(1008,"Remote authorization expired")}}
	if a.control.Expire(){a.broadcastPresence()}
	}}}
