package remote

import (
 "crypto/subtle"
 "io"
 "mime"
 "net"
 "net/http"
)

type roomOwnerControlRequest struct {
 Token string `json:"token"`
 Operation string `json:"operation"`
 Revision uint64 `json:"revision,omitempty"`
 Enabled *bool `json:"enabled,omitempty"`
 ApplicationID string `json:"applicationId,omitempty"`
 HostID string `json:"hostId,omitempty"`
}
type roomOwnerControlView struct {
 Version int `json:"version"`
 Enabled bool `json:"enabled"`
 Revision uint64 `json:"revision"`
 RequestLifetimeSeconds int `json:"requestLifetimeSeconds"`
 Requests []ControlApplication `json:"requests"`
 Leases []Lease `json:"leases"`
}
func(a *Agent)localControlView()roomOwnerControlView{
 record:=a.roomControl.snapshot();requests,leases:=a.control.LocalControl("main")
 return roomOwnerControlView{Version:1,Enabled:record.Enabled,Revision:record.Revision,RequestLifetimeSeconds:90,Requests:requests,Leases:leases}
}
func(a *Agent)controlApplicantReady(application ControlApplication)bool{
 _,registered:=a.backend.Hub.HostSummary(application.Room,application.HostID);if !registered{return false}
 a.mu.Lock();session:=a.sessions[application.Applicant];a.mu.Unlock()
 if session==nil||!session.authenticated.Load()||session.identity.Room!=application.Room{return false}
 session.mu.Lock();defer session.mu.Unlock();return !session.closed&&session.hosts[application.HostID]
}
func(a *Agent)roomOwnerControl(w http.ResponseWriter,r *http.Request){
 if a.roomControl==nil{failHTTP(w,404,"UNAVAILABLE");return}
 if r.Method!="POST"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return}
 peer,_,err:=net.SplitHostPort(r.RemoteAddr);ip:=net.ParseIP(peer);host,_,hostErr:=net.SplitHostPort(r.Host)
 if err!=nil||ip==nil||!ip.IsLoopback()||hostErr!=nil||(host!="localhost"&&host!="127.0.0.1"&&host!="::1")||len(r.Header.Values("Origin"))!=1||r.Header.Get("Origin")!="http://"+r.Host||r.Header.Get("X-Cafe-Room")!="1"{failHTTP(w,403,"LOCAL_OWNER_REQUIRED");return}
 media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type"));if err!=nil||media!="application/json"{failHTTP(w,415,"JSON_REQUIRED");return}
 raw,err:=io.ReadAll(http.MaxBytesReader(w,r.Body,4096));if err!=nil{failHTTP(w,413,"REQUEST_TOO_LARGE");return}
 var q roomOwnerControlRequest
 if strictJSON(raw,&q)!=nil{failHTTP(w,400,"INVALID_REQUEST");return}
 if subtle.ConstantTimeCompare([]byte(q.Token),[]byte(a.backend.ClientToken))!=1{failHTTP(w,401,"UNAUTHORIZED");return};q.Token=""
 if q.Operation=="status"{
  if q.Revision!=0||q.Enabled!=nil||q.ApplicationID!=""||q.HostID!=""{failHTTP(w,400,"INVALID_REQUEST");return}
  a.roomPolicyMu.RLock();view:=a.localControlView();a.roomPolicyMu.RUnlock();reply(w,200,view);return
 }
 if q.Revision==0{failHTTP(w,400,"INVALID_REQUEST");return}
 if q.Operation=="configure"{
  if q.Enabled==nil||q.ApplicationID!=""||q.HostID!=""{failHTTP(w,400,"INVALID_REQUEST");return}
 }else if q.Operation=="approve"||q.Operation=="deny"{
  if q.Enabled!=nil||!tokenPattern.MatchString(q.ApplicationID)||q.HostID!=""{failHTTP(w,400,"INVALID_REQUEST");return}
 }else if q.Operation=="revoke"{
  if q.Enabled!=nil||!tokenPattern.MatchString(q.ApplicationID)||q.HostID==""||len(q.HostID)>256{failHTTP(w,400,"INVALID_REQUEST");return}
 }else{failHTTP(w,400,"INVALID_REQUEST");return}
 a.roomPolicyMu.Lock()
 code:=""
 if a.roomControl.snapshot().Revision!=q.Revision{code="ROOM_CONTROL_CHANGED"}else{
  switch q.Operation{
  case "configure":
   if a.roomControl.change(*q.Enabled,q.Revision)!=nil{code="ROOM_CONTROL_CHANGED"}else{a.control.SetRoomPolicy("main",*q.Enabled)}
  case "approve","deny":
   if q.Operation=="approve"{application,exists:=a.control.Application("main",q.ApplicationID);if !exists{code="CONTROL_REQUEST_GONE"}else if !a.controlApplicantReady(application){code="HOST_NOT_READY"}}
   if code==""{code=a.control.Decide("main",q.ApplicationID,q.Operation=="approve")}
  case "revoke":code=a.control.Revoke("main",q.HostID,q.ApplicationID)
  }
 }
 view:=a.localControlView();a.roomPolicyMu.Unlock()
 // Never hold the policy writer across presence/connection callbacks.
 a.broadcastPresence()
 if code!=""{failHTTP(w,409,code);return};reply(w,200,view)
}
