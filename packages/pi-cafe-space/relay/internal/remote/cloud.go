package remote

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type cloudAgent struct { id, hash string; link *wsLink; ready, rtc, managed bool }
type cloudPeer struct {
	id, userID, userHash, name, deviceID, room, role, mode, selected string
	link *wsLink
	agent *cloudAgent
	offered bool
}
// Cloud has no project filesystem or Pi credentials. It relays opaque business
// frames; all execution authorization is rechecked by the office device.
type Cloud struct {
	roomHosts map[string]*cloudRoomHost
	roomPeers map[string]*cloudRoomPeer
	mu sync.Mutex
	cfg Config
	path string
	healthy, closing bool
	agents map[string]*cloudAgent
	peers map[string]*cloudPeer
	links map[*wsLink]bool
	addresses map[string]int
	connections, unauthenticated int
	budget byteBudget
	start sync.Once
	stop chan struct{}
}
func NewCloud(cfg Config, path string) (*Cloud,error) {
	if err:=cfg.Validate();err!=nil{return nil,err};if cfg.Mode!="cloud"{return nil,errors.New("cloud mode required")}
	return &Cloud{cfg:cfg,path:path,healthy:true,roomHosts:map[string]*cloudRoomHost{},roomPeers:map[string]*cloudRoomPeer{},agents:map[string]*cloudAgent{},peers:map[string]*cloudPeer{},links:map[*wsLink]bool{},addresses:map[string]int{},budget:byteBudget{limit:64*1024*1024},stop:make(chan struct{})},nil
}
func (c *Cloud) Start(ctx context.Context) {
	c.start.Do(func(){go func(){timer:=time.NewTicker(5*time.Second);defer timer.Stop();for{select{case<-ctx.Done():c.Close();return;case<-c.stop:return;case<-timer.C:c.refresh()}}}()})
}
func (c *Cloud) Close() {
	c.mu.Lock();if c.closing{c.mu.Unlock();return};c.closing=true;close(c.stop)
	links:=make([]*wsLink,0,len(c.links));for l:=range c.links{links=append(links,l)};c.mu.Unlock()
	for _,l:=range links{l.Close()}
}
func (c *Cloud) snapshot() (Config,bool) {c.mu.Lock();defer c.mu.Unlock();return c.cfg,c.healthy&&!c.closing}
func (c *Cloud) refresh() {
	if c.path!="" {
		cfg,err:=Load(c.path)
		if err!=nil||cfg.Mode!="cloud"{c.mu.Lock();c.healthy=false;links:=make([]*wsLink,0,len(c.links));for l:=range c.links{links=append(links,l)};c.mu.Unlock();for _,l:=range links{l.Close()};return}
		_ = c.Reload(cfg)
	}
	c.mu.Lock();cfg:=c.cfg;closeLinks:=[]*wsLink{};renew:=[]struct{link *wsLink;id string}{}
	for _,a:=range c.agents{valid:=false;for _,d:=range cfg.Devices{if d.ID==a.id&&!d.Disabled&&d.TokenHash==a.hash{valid=true}};if !valid{closeLinks=append(closeLinks,a.link)}}
	for _,p:=range c.roomPeers{if !cfg.RoomAccess||!cfg.EnableWebRTC{closeLinks=append(closeLinks,p.link)}else{renew=append(renew,struct{link *wsLink;id string}{p.host.link,p.id})}}
	for _,p:=range c.peers{if !validPeer(cfg,p){closeLinks=append(closeLinks,p.link)}else{renew=append(renew,struct{link *wsLink;id string}{p.agent.link,p.id})}}
	c.mu.Unlock()
	for _,l:=range closeLinks{l.Close()};for _,r:=range renew{_ = r.link.Send(Frame{Type:"renew",ID:r.id})}
}
func validPeer(cfg Config,p *cloudPeer) bool {
	for _,u:=range cfg.Users{if u.ID!=p.userID||u.Disabled||u.TokenHash!=p.userHash{continue};if u.ExpiresAt!=""{t,err:=time.Parse(time.RFC3339,u.ExpiresAt);if err!=nil||!time.Now().Before(t){return false}};role,ok:=u.RoleFor(p.deviceID,p.room);return ok&&role==p.role}
	return false
}
// Reload is also used by the periodic file watcher. Invalid updates fail closed;
// the old account table is never silently used after a parse/validation failure.
func(c *Cloud) Reload(cfg Config) error {
	if err:=cfg.Validate();err!=nil{return err};if cfg.Mode!="cloud"{return errors.New("cannot change remote mode live")}
	c.mu.Lock();if c.closing{c.mu.Unlock();return errClosed};oldOrigin:=c.cfg.PublicOrigin;c.cfg=cfg;c.healthy=true;links:=[]*wsLink{}
	for _,p:=range c.peers{if !validPeer(cfg,p)||oldOrigin!=cfg.PublicOrigin{links=append(links,p.link)}}
	for _,a:=range c.agents{valid:=false;for _,d:=range cfg.Devices{if d.ID==a.id&&!d.Disabled&&d.TokenHash==a.hash{valid=true}};if !valid{links=append(links,a.link)}}
	if !cfg.RoomAccess||!cfg.EnableWebRTC||oldOrigin!=cfg.PublicOrigin{for _,h:=range c.roomHosts{links=append(links,h.link)};for _,p:=range c.roomPeers{links=append(links,p.link)}}
	c.mu.Unlock();for _,l:=range links{l.Close()};return nil
}
func originMatches(r *http.Request,cfg Config) bool {return len(r.Header.Values("Origin"))==1&&r.Header.Get("Origin")==strings.TrimSuffix(cfg.PublicOrigin,"/")}
func bearer(r *http.Request) string {h:=r.Header.Values("Authorization");if len(h)!=1||!strings.HasPrefix(h[0],"Bearer "){return ""};v:=strings.TrimPrefix(h[0],"Bearer ");if !tokenPattern.MatchString(v){return ""};return v}
func remoteHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control","no-store");w.Header().Set("X-Content-Type-Options","nosniff");w.Header().Set("Referrer-Policy","no-referrer");w.Header().Set("X-Frame-Options","DENY")
	w.Header().Set("Content-Security-Policy","default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
}
func reply(w http.ResponseWriter,status int,value any){w.Header().Set("Content-Type","application/json; charset=utf-8");w.WriteHeader(status);_ = json.NewEncoder(w).Encode(value)}
func failHTTP(w http.ResponseWriter,status int,code string){reply(w,status,map[string]string{"error":code})}
func(c *Cloud) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		path:=r.URL.Path
		if path!="/room/host"&&path!="/room/join"&&path!="/api/room/status"&&path!="/api/config"&&path!="/ws"&&!strings.HasPrefix(path,"/remote/")&&!strings.HasPrefix(path,"/api/remote/")&&path!="/api/workspace"{next.ServeHTTP(w,r);return}
		remoteHeaders(w)
		if r.URL.RawPath!=""||r.URL.EscapedPath()!=path||r.URL.RawQuery!=""{failHTTP(w,400,"INVALID_REQUEST");return}
		cfg,ok:=c.snapshot();if !ok{failHTTP(w,503,"REMOTE_UNAVAILABLE");return}
		switch path {
		case "/api/config":
			if r.Method!="GET"&&r.Method!="HEAD"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return}
			if r.Method=="HEAD"{w.WriteHeader(200);return}
			reply(w,200,map[string]any{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main","remoteAccess":true,"managedSessions":true,"roomAccess":cfg.RoomAccess,"accountLogin":cfg.RoomAccess&&cfg.AccountIssuer!=""})
		case "/room/host":c.roomHost(w,r,cfg)
		case "/room/join":c.roomBrowser(w,r,cfg)
		case "/api/room/status":c.roomStatus(w,r,cfg)
		case "/api/remote/devices":if cfg.RoomAccess{failHTTP(w,404,"ROOM_LINK_REQUIRED");return};c.devices(w,r,cfg)
		case "/remote/agent":if cfg.RoomAccess{failHTTP(w,404,"ROOM_LINK_REQUIRED");return};c.agent(w,r,cfg)
		case "/remote/connect":if cfg.RoomAccess{failHTTP(w,404,"ROOM_LINK_REQUIRED");return};c.browser(w,r,cfg)
		default:failHTTP(w,404,"REMOTE_ENDPOINT_NOT_FOUND")
		}
	})
}
func(c *Cloud) devices(w http.ResponseWriter,r *http.Request,cfg Config){
	if r.Method!="POST"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return};if !originMatches(r,cfg){failHTTP(w,403,"ORIGIN_DENIED");return}
	u,ok:=cfg.AuthenticateUser(bearer(r));if !ok{failHTTP(w,401,"UNAUTHORIZED");return}
	r.Body=http.MaxBytesReader(w,r.Body,4096);defer r.Body.Close();body,err:=io.ReadAll(r.Body);if err!=nil{failHTTP(w,413,"INVALID_REQUEST");return};if len(body)>0{var empty struct{};if strictJSON(body,&empty)!=nil{failHTTP(w,400,"INVALID_REQUEST");return}}
	devices:=[]map[string]any{}
	c.mu.Lock()
	for _,d:=range cfg.Devices{if d.Disabled{continue};rooms:=[]map[string]string{};for _,g:=range u.Grants{if g.DeviceID==d.ID{rooms=append(rooms,map[string]string{"id":g.Room,"role":g.Role})}};if len(rooms)==0{continue};a:=c.agents[d.ID];online:=a!=nil&&a.ready;devices=append(devices,map[string]any{"id":d.ID,"name":d.Name,"rooms":rooms,"online":online,"webRTC":online&&a.rtc&&cfg.EnableWebRTC})}
	c.mu.Unlock();reply(w,200,map[string]any{"user":map[string]string{"id":u.ID,"name":u.Name},"devices":devices})
}
// Admission counts live sockets and the unauthenticated phase separately. The
// actual TCP address is used, never a user-supplied forwarded header.
func(c *Cloud) admit(r *http.Request)(func(),func(),bool){
	address,_,err:=net.SplitHostPort(r.RemoteAddr);if err!=nil{address=r.RemoteAddr}
	c.mu.Lock();if c.closing||c.connections>=256||c.unauthenticated>=64||c.addresses[address]>=32{c.mu.Unlock();return nil,nil,false};c.connections++;c.unauthenticated++;c.addresses[address]++;c.mu.Unlock()
	var phase sync.Once;var lifetime sync.Once
	authed:=func(){phase.Do(func(){c.mu.Lock();c.unauthenticated--;c.mu.Unlock()})}
	done:=func(){lifetime.Do(func(){authed();c.mu.Lock();c.connections--;c.addresses[address]--;if c.addresses[address]==0{delete(c.addresses,address)};c.mu.Unlock()})}
	return authed,done,true
}
func(c *Cloud) track(l *wsLink)bool{c.mu.Lock();defer c.mu.Unlock();if c.closing{return false};c.links[l]=true;return true}
func(c *Cloud) untrack(l *wsLink){l.Close();c.mu.Lock();delete(c.links,l);c.mu.Unlock()}
func(c *Cloud) agent(w http.ResponseWriter,r *http.Request,cfg Config){
	if r.Method!="GET"||r.Header.Get("Origin")!=""{failHTTP(w,403,"ORIGIN_DENIED");return}
	id:=r.Header.Get("X-Cafe-Device");d,ok:=cfg.AuthenticateDevice(id,bearer(r));if !ok{failHTTP(w,401,"UNAUTHORIZED");return}
	authed,done,ok:=c.admit(r);if !ok{failHTTP(w,503,"CONNECTION_LIMIT");return};defer done()
	up:=websocket.Upgrader{HandshakeTimeout:5*time.Second,CheckOrigin:func(*http.Request)bool{return true},EnableCompression:false}
	conn,err:=up.Upgrade(w,r,nil);if err!=nil{return};l:=newWSLink(conn,&c.budget);if !c.track(l){l.Close();return};defer c.untrack(l);authed()
	a:=&cloudAgent{id:d.ID,hash:d.TokenHash,link:l}
	c.mu.Lock();old:=c.agents[d.ID];c.agents[d.ID]=a;c.mu.Unlock();if old!=nil{old.link.Close()}
	defer func(){c.mu.Lock();if c.agents[d.ID]==a{delete(c.agents,d.ID)};peers:=[]*wsLink{};for _,p:=range c.peers{if p.agent==a{peers=append(peers,p.link)}};c.mu.Unlock();for _,p:=range peers{p.Close()}}()
	_ = conn.SetReadDeadline(time.Now().Add(5*time.Second))
	for {f,err:=l.Read();if err!=nil{return};if f.Type=="ready"&&f.ID==""{c.mu.Lock();if a.ready{c.mu.Unlock();return};a.ready=true;a.rtc=f.WebRTC;a.managed=f.Managed;c.mu.Unlock();continue}
		c.mu.Lock();p:=c.peers[f.ID];valid:=p!=nil&&p.agent==a&&a.ready
		if valid&&f.Type=="selected"{if p.selected!=""||(f.Mode!="relay"&&f.Mode!="webrtc"){valid=false}else{p.selected=f.Mode}}
		c.mu.Unlock();if p==nil{continue};if !valid{return}
		switch f.Type{
		case "opened":
			if roleRank(f.Role)==0||roleRank(f.Role)>roleRank(p.role){return};_ = p.link.Send(Frame{Type:"opened",ID:p.id,DeviceID:p.deviceID,Room:p.room,UserID:p.userID,Name:p.name,Role:f.Role,WebRTC:f.WebRTC&&cfg.EnableWebRTC,Managed:f.Managed,ICEServers:c.iceServers(p.userID)})
		case "answer":if len(f.SDP)==0{return};_ = p.link.Send(Frame{Type:"answer",ID:p.id,SDP:f.SDP})
		case "selected":_ = p.link.Send(Frame{Type:"selected",ID:p.id,Mode:f.Mode})
		case "data":if p.selected!="relay"||len(f.Payload)==0{return};_ = p.link.Send(Frame{Type:"data",ID:p.id,Payload:f.Payload})
		case "signal_error":_ = p.link.Send(Frame{Type:"signal_error",ID:p.id,Code:"WEBRTC_UNAVAILABLE"})
		case "closed":p.link.Close()
		default:return
		}
	}
}
func(c *Cloud) browser(w http.ResponseWriter,r *http.Request,cfg Config){
	if r.Method!="GET"||!originMatches(r,cfg){failHTTP(w,403,"ORIGIN_DENIED");return}
	authed,done,ok:=c.admit(r);if !ok{failHTTP(w,503,"CONNECTION_LIMIT");return};defer done()
	up:=websocket.Upgrader{HandshakeTimeout:5*time.Second,CheckOrigin:func(*http.Request)bool{return true},EnableCompression:false}
	conn,err:=up.Upgrade(w,r,nil);if err!=nil{return};l:=newWSLink(conn,&c.budget);if !c.track(l){l.Close();return};defer c.untrack(l)
	_ = conn.SetReadDeadline(time.Now().Add(5*time.Second))
	first,err:=l.Read();if err!=nil||first.Type!="connect"||first.ID!=""||len(first.Payload)>0||first.SDP!=""||first.UserID!=""||first.Role!=""||!identifier.MatchString(first.DeviceID)||!identifier.MatchString(first.Room)||(first.Mode!="auto"&&first.Mode!="relay"&&first.Mode!="webrtc"){return}
	cfg,ok=c.snapshot();if !ok||!originMatches(r,cfg){return}
	rejectAuth := func() { _ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4003, "Remote access denied"), time.Now().Add(time.Second)) }
	u,ok:=cfg.AuthenticateUser(first.Token);if !ok{rejectAuth();return};role,ok:=u.RoleFor(first.DeviceID,first.Room);if !ok{rejectAuth();return}
	id,err:=NewToken();if err!=nil{return}
	c.mu.Lock();a:=c.agents[first.DeviceID];userCount,deviceCount:=0,0;for _,p:=range c.peers{if p.userID==u.ID{userCount++};if p.deviceID==first.DeviceID{deviceCount++}}
	if c.closing||!c.healthy||a==nil||!a.ready||len(c.peers)>=MaxPeers||userCount>=8||deviceCount>=MaxDevicePeers{c.mu.Unlock();return}
	p:=&cloudPeer{id:id,userID:u.ID,userHash:u.TokenHash,name:u.Name,deviceID:a.id,room:first.Room,role:role,mode:first.Mode,link:l,agent:a};c.peers[id]=p;c.mu.Unlock();authed()
	defer func(){c.mu.Lock();delete(c.peers,id);c.mu.Unlock();_ = a.link.Send(Frame{Type:"close",ID:id})}()
	if a.link.Send(Frame{Type:"open",ID:id,UserID:u.ID,Name:u.Name,Room:p.room,Role:role,Mode:p.mode,ICEServers:c.iceServers(u.ID)})!=nil{return}
	for {f,err:=l.Read();if err!=nil{return};if f.ID!=""&&f.ID!=id{return};if f.Token!=""||f.UserID!=""||f.Role!=""||f.DeviceID!=""||f.Room!=""||f.Name!=""||len(f.ICEServers)>0{return};f.ID=id
		c.mu.Lock();selected:=p.selected
		if f.Type=="offer"{if p.offered||selected!=""||p.mode=="relay"||!c.cfg.EnableWebRTC{c.mu.Unlock();return};p.offered=true};c.mu.Unlock()
		switch f.Type{
		case "offer":if len(f.SDP)==0||len(f.Payload)>0{return}
		case "select":if selected!=""||(f.Mode!="relay"&&f.Mode!="webrtc")||p.mode=="webrtc"&&f.Mode!="webrtc"{return}
		case "data":if selected!="relay"||len(f.Payload)==0||f.SDP!=""{return}
		default:return
		}
		if a.link.Send(f)!=nil{return}
	}
}
func(c *Cloud) iceServers(userID string)[]ICEServer{
	cfg,ok:=c.snapshot();if !ok{return nil};result:=append([]ICEServer{},cfg.ICEServers...)
	if cfg.TURN!=nil{ttl:=cfg.TURN.TTLSeconds;if ttl==0{ttl=600};username:=strconv.FormatInt(time.Now().Add(time.Duration(ttl)*time.Second).Unix(),10)+":"+userID;mac:=hmac.New(sha1.New,[]byte(cfg.TURN.SharedSecret));_,_ = mac.Write([]byte(username));result=append(result,ICEServer{URLs:append([]string{},cfg.TURN.URLs...),Username:username,Credential:base64.StdEncoding.EncodeToString(mac.Sum(nil))})}
	return result
}
