package remote

import (
 "encoding/json"
 "errors"
 "os"
 "path/filepath"
 "sort"
 "strings"
 "sync"
 "time"
)

const controlRequestLifetime = 90*time.Second
const controlRequestRetention = time.Minute
const controlRequestLimit = 64

type ControlApplication struct {
 ID string `json:"id"`
 HostID string `json:"hostId"`
 Applicant string `json:"applicant"`
 UserID string `json:"userId"`
 Name string `json:"name"`
 IdentityKind string `json:"identityKind,omitempty"`
 Room string `json:"room"`
 State string `json:"state"`
 CreatedAt int64 `json:"createdAt"`
 ExpiresAt int64 `json:"expiresAt"`
}
type roomControlRecord struct { Version int `json:"version"`; Enabled bool `json:"enabled"`; Revision uint64 `json:"revision"` }
type roomControlSettings struct { mu sync.Mutex; path, hash string; record roomControlRecord }

// A separate sidecar keeps room identities/passwords untouched and lets older
// binaries still read their identity file. Invalid settings never downgrade.
func loadRoomControlSettings(identityPath string)(*roomControlSettings,error){
 path:=identityPath+".control.json"
 result:=&roomControlSettings{path:path,record:roomControlRecord{Version:1,Revision:1}}
 raw,err:=privateRoomBytes(path)
 if errors.Is(err,os.ErrNotExist){return result,nil};if err!=nil{return nil,err}
 if strictJSON(raw,&result.record)!=nil||result.record.Version!=1||result.record.Revision==0||result.record.Revision>9007199254740990{return nil,errors.New("invalid room control settings")}
 result.hash=roomDigest(string(raw));return result,nil
}
func(o *roomControlSettings)snapshot()roomControlRecord{o.mu.Lock();defer o.mu.Unlock();return o.record}
func(o *roomControlSettings)change(enabled bool,revision uint64)error{
 o.mu.Lock();defer o.mu.Unlock()
 if revision!=o.record.Revision||revision>=9007199254740990{return errors.New("room control revision changed")}
 if enabled==o.record.Enabled{return nil}
 next:=o.record;next.Enabled=enabled;next.Revision++
 raw,err:=json.Marshal(next);if err!=nil{return err}
 f,err:=os.CreateTemp(filepath.Dir(o.path),".room-control-*");if err!=nil{return err};defer os.Remove(f.Name())
 if _,err=f.Write(raw);err==nil{err=f.Sync()};closed:=f.Close();if err!=nil{return err};if closed!=nil{return closed}
 if o.hash=="" {err=os.Link(f.Name(),o.path)} else {
  old,e:=privateRoomBytes(o.path);if e!=nil||roomDigest(string(old))!=o.hash{return errors.New("room control file changed")}
  err=os.Rename(f.Name(),o.path)
 }
 if err!=nil{return err};o.record=next;o.hash=roomDigest(string(raw));return nil
}

// All methods below are called with c.mu held, except the exported wrappers.
func(c *coordinator)roomModeLocked(room string)string{
 enabled,exists:=c.roomPolicies[room];if !exists{return "legacy"};if enabled{return "approval"};return "disabled"
}
func(c *coordinator)RoomMode(room string)string{c.mu.Lock();defer c.mu.Unlock();return c.roomModeLocked(room)}
func(c *coordinator)SetRoomPolicy(room string,enabled bool){
 c.mu.Lock();defer c.mu.Unlock();if value,exists:=c.roomPolicies[room];exists&&value==enabled{return}
 if c.roomPolicies==nil{c.roomPolicies=map[string]bool{}};c.roomPolicies[room]=enabled
 for key:=range c.leases{if strings.HasPrefix(key,room+"\x00"){delete(c.leases,key)}}
 for id,application:=range c.applications{if application.Room==room{delete(c.applications,id)}}
}
func(c *coordinator)ForgetRoomApprovals(room string){
 c.mu.Lock();defer c.mu.Unlock()
 for key:=range c.leases{if strings.HasPrefix(key,room+"\x00"){delete(c.leases,key)}}
 for id,q:=range c.applications{if q.Room==room{delete(c.applications,id)}}
}
func(c *coordinator)finishApplicationLocked(id,state string){
 q,exists:=c.applications[id];if !exists{return};q.State=state;q.ExpiresAt=c.now().Add(controlRequestRetention).UnixMilli();c.applications[id]=q
}
func(c *coordinator)requestLocked(p Identity,host string)string{
 c.expireApplicationsLocked()
 key:=p.Room+"\x00"+host
 if lease,ok:=c.leases[key];ok&&lease.Holder==p.ID&&lease.ExpiresAt>c.now().UnixMilli(){return ""}
 pending:=0
 for id,q:=range c.applications{
  if q.Applicant!=p.ID{continue}
  if q.HostID==host&&q.Room==p.Room{
   if q.State=="pending"{return ""}
   delete(c.applications,id)
  }else if q.State=="pending"{pending++}
 }
 if len(c.applications)>=controlRequestLimit||pending>=8{return "CONTROL_LIMIT"}
 id,err:=NewToken();if err!=nil{return "CONTROL_UNAVAILABLE"}
 if c.applications==nil{c.applications=map[string]ControlApplication{}}
 now:=c.now();c.applications[id]=ControlApplication{ID:id,HostID:host,Applicant:p.ID,UserID:p.UserID,Name:p.Name,IdentityKind:p.Kind,Room:p.Room,State:"pending",CreatedAt:now.UnixMilli(),ExpiresAt:now.Add(controlRequestLifetime).UnixMilli()}
 return ""
}
func(c *coordinator)expireApplicationsLocked()bool{
 changed:=false;now:=c.now().UnixMilli()
 for id,q:=range c.applications{if q.State=="approved"{lease,ok:=c.leases[q.Room+"\x00"+q.HostID];if ok&&lease.ApprovalID==id&&lease.ExpiresAt>now{continue};if ok&&lease.ApprovalID==id{delete(c.leases,q.Room+"\x00"+q.HostID)};c.finishApplicationLocked(id,"expired");changed=true;continue};if q.ExpiresAt>now{continue};changed=true;if q.State=="pending"{c.finishApplicationLocked(id,"expired")}else{delete(c.applications,id)}}
 return changed
}
func(c *coordinator)applicationsLocked(room,applicant string)[]ControlApplication{
 out:=[]ControlApplication{};for _,q:=range c.applications{if q.Room==room&&(applicant==""||q.Applicant==applicant){out=append(out,q)}}
 sort.Slice(out,func(i,j int)bool{if out[i].CreatedAt==out[j].CreatedAt{return out[i].ID<out[j].ID};return out[i].CreatedAt<out[j].CreatedAt});return out
}
func(c *coordinator)LocalControl(room string)([]ControlApplication,[]Lease){
 c.mu.Lock();defer c.mu.Unlock();applications:=c.applicationsLocked(room,"");leases:=[]Lease{}
 for key,l:=range c.leases{if strings.HasPrefix(key,room+"\x00")&&l.ExpiresAt>c.now().UnixMilli(){leases=append(leases,l)}}
 sort.Slice(leases,func(i,j int)bool{return leases[i].HostID<leases[j].HostID});return applications,leases
}
func(c *coordinator)Application(room,id string)(ControlApplication,bool){c.mu.Lock();defer c.mu.Unlock();q,ok:=c.applications[id];return q,ok&&q.Room==room}
func(c *coordinator)CancelApplication(p Identity,id string)string{
 c.mu.Lock();defer c.mu.Unlock();if c.peers[p.ID]!=p{return "NOT_CONNECTED"};q,ok:=c.applications[id]
 if !ok||q.Applicant!=p.ID||q.Room!=p.Room{return "CONTROL_REQUEST_GONE"}
 if q.State=="cancelled"{return ""};if q.State!="pending"{return "CONTROL_REQUEST_GONE"}
 c.finishApplicationLocked(id,"cancelled");return ""
}
// This entry point is ONLY called by the authenticated loopback owner handler.
// Remote peers, including a remotely claimed admin, never reach this method.
func(c *coordinator)Decide(room,id string,approve bool)string{
 c.mu.Lock();defer c.mu.Unlock()
 if c.roomModeLocked(room)!="approval"{return "CONTROL_DISABLED"}
 q,ok:=c.applications[id];if !ok||q.Room!=room{return "CONTROL_REQUEST_GONE"}
 if q.State!="pending"{return "CONTROL_REQUEST_GONE"}
 if q.ExpiresAt<=c.now().UnixMilli(){c.finishApplicationLocked(id,"expired");return "CONTROL_REQUEST_EXPIRED"}
 p,ok:=c.peers[q.Applicant];if !ok||p.Room!=room||p.UserID!=q.UserID||roleRank(p.Role)<2{return "CONTROL_REQUEST_GONE"}
 if !approve{c.finishApplicationLocked(id,"denied");return ""}
 key:=room+"\x00"+q.HostID
 if current,ok:=c.leases[key];ok{if current.ExpiresAt>c.now().UnixMilli(){return "CONTROL_BUSY"};delete(c.leases,key);c.finishApplicationLocked(current.ApprovalID,"expired")}
 if len(c.leases)>=64{return "CONTROL_LIMIT"}
 c.leases[key]=Lease{HostID:q.HostID,Holder:p.ID,UserID:p.UserID,Name:p.Name,ExpiresAt:c.now().Add(leaseDuration).UnixMilli(),ApprovalID:id}
 q.State="approved";q.ExpiresAt=c.leases[key].ExpiresAt;c.applications[id]=q;return ""
}
func(c *coordinator)Revoke(room,host,approval string)string{
 c.mu.Lock();defer c.mu.Unlock();key:=room+"\x00"+host;lease,ok:=c.leases[key]
 if !ok||approval==""||lease.ApprovalID!=approval{return "CONTROL_REQUEST_GONE"}
 delete(c.leases,key);c.finishApplicationLocked(approval,"revoked");return ""
}
