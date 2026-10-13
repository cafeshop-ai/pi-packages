package remote

import (
 "crypto/subtle"
 "io"
 "mime"
 "net"
 "net/http"
)

// Native owner UI uses the actual owner credential AND the local Pi credential.
// This does not upgrade the existing host-token-only, read-only terminal API.
// Remote browsers cannot use this endpoint, even with their room password.
func(a *Agent)roomTerminalOwner(w http.ResponseWriter,r *http.Request){
 remoteHeaders(w)
 if a.roomControl==nil{failHTTP(w,404,"UNAVAILABLE");return}
 if r.Method!="POST"{failHTTP(w,405,"METHOD_NOT_ALLOWED");return}
 peer,_,peerErr:=net.SplitHostPort(r.RemoteAddr);ip:=net.ParseIP(peer);host,_,hostErr:=net.SplitHostPort(r.Host)
 if peerErr!=nil||hostErr!=nil||ip==nil||!ip.IsLoopback()||(host!="127.0.0.1"&&host!="localhost"&&host!="::1")||len(r.Header.Values("Origin"))!=0||r.URL.RawQuery!=""||r.Header.Get("X-Cafe-Local-Owner")!="1"{failHTTP(w,403,"LOCAL_OWNER_REQUIRED");return}
 if a.backend.ClientToken==""||a.backend.HostToken==""||len(r.Header.Values("Authorization"))!=1||len(r.Header.Values("X-Cafe-Pi-Authorization"))!=1||subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")),[]byte("Bearer "+a.backend.ClientToken))!=1||subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cafe-Pi-Authorization")),[]byte("Bearer "+a.backend.HostToken))!=1{failHTTP(w,401,"UNAUTHORIZED");return}
 media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type"));if err!=nil||media!="application/json"{failHTTP(w,415,"JSON_REQUIRED");return}
 raw,err:=io.ReadAll(http.MaxBytesReader(w,r.Body,2048));if err!=nil{failHTTP(w,413,"REQUEST_TOO_LARGE");return}
 var q struct{Operation string `json:"operation"`;Room string `json:"room"`;PeerID string `json:"peerId"`;Revision uint64 `json:"revision,omitempty"`;ApplicationID string `json:"applicationId,omitempty"`}
 if strictJSON(raw,&q)!=nil||q.Room!="main"||q.PeerID==""||len(q.PeerID)>256{failHTTP(w,400,"INVALID_REQUEST");return}
 _,present:=a.backend.Hub.HostSummary("main",q.PeerID);if !present{failHTTP(w,403,"HOST_NOT_READY");return}
 if q.Operation=="status"{if q.Revision!=0||q.ApplicationID!=""{failHTTP(w,400,"INVALID_REQUEST");return}}else if (q.Operation!="approve"&&q.Operation!="deny")||q.Revision==0||!tokenPattern.MatchString(q.ApplicationID){failHTTP(w,400,"INVALID_REQUEST");return}
 a.roomPolicyMu.Lock()
 code:=""
 if q.Operation!="status"{
  if q.Revision!=a.roomControl.snapshot().Revision{code="ROOM_CONTROL_CHANGED"}else{
   application,exists:=a.control.Application("main",q.ApplicationID)
   if !exists||application.HostID!=q.PeerID{code="CONTROL_REQUEST_GONE"}else if q.Operation=="approve"&&!a.controlApplicantReady(application){code="HOST_NOT_READY"}else{code=a.control.Decide("main",q.ApplicationID,q.Operation=="approve")}
  }
 }
 view:=a.localControlView();a.roomPolicyMu.Unlock()
 if q.Operation!="status"{a.broadcastPresence()}
 if code!=""{failHTTP(w,409,code);return}
 requests:=[]ControlApplication{}
 for _,application:=range view.Requests{if application.HostID==q.PeerID&&application.State=="pending"{requests=append(requests,application)}}
 reply(w,200,map[string]any{"version":1,"enabled":view.Enabled,"revision":view.Revision,"hostId":q.PeerID,"requests":requests})
}
