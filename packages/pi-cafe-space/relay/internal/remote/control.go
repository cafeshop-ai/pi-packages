package remote

import (
	"sort"
	"strings"
	"sync"
	"time"
)

const leaseDuration = 30*time.Second
const visitorReconnectGrace = 5*time.Minute

type Identity struct { ID string `json:"id"`; UserID string `json:"userId"`; Name string `json:"name"`; Room string `json:"room"`; Role string `json:"role"`; Verified bool `json:"-"`; Kind string `json:"identityKind,omitempty"`; AccountID string `json:"accountId,omitempty"` }
type Lease struct { HostID string `json:"hostId"`; Holder string `json:"holder"`; UserID string `json:"userId"`; Name string `json:"name"`; ExpiresAt int64 `json:"expiresAt"`; ApprovalID string `json:"approvalId,omitempty"` }
type Presence struct { Type string `json:"type"`; Self string `json:"self"`; Role string `json:"role"`; Members []Identity `json:"members"`; Leases []Lease `json:"leases"`; ControlPolicy string `json:"controlPolicy,omitempty"`; Applications []ControlApplication `json:"controlRequests,omitempty"` }
type coordinator struct { mu sync.Mutex; roomPolicies map[string]bool; applications map[string]ControlApplication; peers map[string]Identity; leases map[string]Lease; now func()time.Time }
func newCoordinator(now func()time.Time)*coordinator{return &coordinator{peers:map[string]Identity{},leases:map[string]Lease{},now:now}}
func(c *coordinator) Join(p Identity)bool{
 c.mu.Lock();defer c.mu.Unlock();if _,ok:=c.peers[p.ID];ok||len(c.peers)>=MaxDevicePeers{return false};c.peers[p.ID]=p
 if p.Verified&&c.roomModeLocked(p.Room)=="approval"{
  now:=c.now().UnixMilli()
  for key,l:=range c.leases{if strings.HasPrefix(key,p.Room+"\x00")&&l.UserID==p.UserID&&l.ExpiresAt>now{l.Holder=p.ID;l.Name=p.Name;l.ExpiresAt=c.now().Add(leaseDuration).UnixMilli();c.leases[key]=l;if q,ok:=c.applications[l.ApprovalID];ok{q.Applicant=p.ID;q.Name=p.Name;q.ExpiresAt=l.ExpiresAt;c.applications[q.ID]=q}}}
  for id,q:=range c.applications{if q.Room==p.Room&&q.UserID==p.UserID&&q.State=="pending"&&q.ExpiresAt>now{q.Applicant=p.ID;q.Name=p.Name;c.applications[id]=q}}
 }
 return true
}
func(c *coordinator) Leave(id string){
 c.mu.Lock();defer c.mu.Unlock();p,exists:=c.peers[id];if !exists{return};delete(c.peers,id);resume:=p.Verified&&c.roomModeLocked(p.Room)=="approval"
 for key,l:=range c.leases{if l.Holder==id{if resume&&l.ExpiresAt>c.now().UnixMilli(){l.ExpiresAt=c.now().Add(visitorReconnectGrace).UnixMilli();c.leases[key]=l;if q,ok:=c.applications[l.ApprovalID];ok{q.ExpiresAt=l.ExpiresAt;c.applications[q.ID]=q}}else{delete(c.leases,key);c.finishApplicationLocked(l.ApprovalID,"expired")}}}
 for key,q:=range c.applications{if q.Applicant==id&&(!resume||q.State!="pending"&&q.State!="approved"){delete(c.applications,key)}}
}
func(c *coordinator) Change(p Identity,host,action string,force bool)string{
	c.mu.Lock();defer c.mu.Unlock()
	if c.peers[p.ID]!=p{return "NOT_CONNECTED"}
	if roleRank(p.Role)<2{return "READ_ONLY"};mode:=c.roomModeLocked(p.Room);if force&&(p.Role!="admin"||mode!="legacy"){return "FORBIDDEN"}
	if host==""||len(host)>256||strings.ContainsAny(host,"\x00\r\n"){return "INVALID_REQUEST"}
	if mode=="disabled"{return "CONTROL_DISABLED"}
	key:=p.Room+"\x00"+host;current,ok:=c.leases[key];now:=c.now();if ok&&current.ExpiresAt<=now.UnixMilli(){delete(c.leases,key);c.finishApplicationLocked(current.ApprovalID,"expired");ok=false}
	switch action{
	case "acquire":
		if mode=="approval"{return c.requestLocked(p,host)}
		if ok&&current.Holder!=p.ID&&!force{return "CONTROL_BUSY"}
		if !ok&&len(c.leases)>=64{return "CONTROL_LIMIT"}
		c.leases[key]=Lease{HostID:host,Holder:p.ID,UserID:p.UserID,Name:p.Name,ExpiresAt:now.Add(leaseDuration).UnixMilli()}
	case "renew":
		if !ok||current.Holder!=p.ID{return "CONTROL_REQUIRED"};current.ExpiresAt=now.Add(leaseDuration).UnixMilli();c.leases[key]=current;if q,exists:=c.applications[current.ApprovalID];exists{q.ExpiresAt=current.ExpiresAt;c.applications[q.ID]=q}
	case "release":
		if !ok{return ""};if current.Holder!=p.ID{return "FORBIDDEN"};delete(c.leases,key);c.finishApplicationLocked(current.ApprovalID,"released")
	default:return "INVALID_REQUEST"
	}
	return ""
}
func(c *coordinator) CanWrite(p Identity,host string)string{
	c.mu.Lock();defer c.mu.Unlock()
	if c.peers[p.ID]!=p{return "NOT_CONNECTED"};if roleRank(p.Role)<2{return "READ_ONLY"};if c.roomModeLocked(p.Room)=="disabled"{return ""}
	l,ok:=c.leases[p.Room+"\x00"+host];if !ok||l.Holder!=p.ID||l.ExpiresAt<=c.now().UnixMilli(){return "CONTROL_REQUIRED"};return ""
}
func(c *coordinator) Expire()bool{c.mu.Lock();defer c.mu.Unlock();changed:=false;now:=c.now().UnixMilli();for key,l:=range c.leases{if l.ExpiresAt<=now{delete(c.leases,key);c.finishApplicationLocked(l.ApprovalID,"expired");changed=true}};return c.expireApplicationsLocked()||changed}
func(c *coordinator) Snapshot(p Identity)Presence{
	c.mu.Lock();defer c.mu.Unlock();result:=Presence{Type:"remote.presence",Self:p.ID,Role:p.Role,Members:[]Identity{},Leases:[]Lease{},ControlPolicy:c.roomModeLocked(p.Room)};if result.ControlPolicy=="approval"{result.Applications=c.applicationsLocked(p.Room,p.ID)}
	for _,peer:=range c.peers{if peer.Room==p.Room{result.Members=append(result.Members,peer)}}
	for key,l:=range c.leases{if holder,online:=c.peers[l.Holder];online&&holder.Room==p.Room&&strings.HasPrefix(key,p.Room+"\x00")&&l.ExpiresAt>c.now().UnixMilli(){result.Leases=append(result.Leases,l)}}
	sort.Slice(result.Members,func(i,j int)bool{return result.Members[i].ID<result.Members[j].ID});sort.Slice(result.Leases,func(i,j int)bool{return result.Leases[i].HostID<result.Leases[j].HostID});return result
}
