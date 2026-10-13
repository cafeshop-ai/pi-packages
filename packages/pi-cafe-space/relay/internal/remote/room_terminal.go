package remote

import (
 "crypto/subtle"
 "io"
 "mime"
 "net"
 "net/http"
 "strings"
)

// A local host credential can read sharing information, not mutate room access.
// Browsers keep their separate, owner-token-protected /api/room/share interface.
func (a *Agent) roomTerminal(w http.ResponseWriter, r *http.Request) {
 remoteHeaders(w)
 if r.Method != "POST" { failHTTP(w,405,"METHOD_NOT_ALLOWED"); return }
 peer,_,err:=net.SplitHostPort(r.RemoteAddr); host,_,hostErr:=net.SplitHostPort(r.Host); ip:=net.ParseIP(peer)
 if err!=nil || ip==nil || !ip.IsLoopback() || hostErr!=nil || (host!="localhost"&&host!="127.0.0.1"&&host!="::1") || len(r.Header.Values("Origin"))!=0 || r.Header.Get("X-Cafe-Terminal")!="1" { failHTTP(w,403,"LOCAL_TERMINAL_REQUIRED"); return }
 if a.backend.HostToken=="" || len(r.Header.Values("Authorization"))!=1 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")),[]byte("Bearer "+a.backend.HostToken))!=1 { failHTTP(w,401,"UNAUTHORIZED"); return }
 media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type")); if err!=nil||media!="application/json" { failHTTP(w,415,"JSON_REQUIRED"); return }
 raw,err:=io.ReadAll(http.MaxBytesReader(w,r.Body,2048));if err!=nil {failHTTP(w,413,"REQUEST_TOO_LARGE");return}
 var q struct { Operation string `json:"operation"`; Room string `json:"room"`; PeerID string `json:"peerId"` }
 if strictJSON(raw,&q)!=nil || (q.Operation!="status"&&q.Operation!="share"&&q.Operation!="diagnostics") || !identifier.MatchString(q.Room) || q.PeerID=="" || len(q.PeerID)>256 || strings.ContainsAny(q.PeerID,"\x00\r\n") { failHTTP(w,400,"INVALID_REQUEST");return }
 if q.Operation=="diagnostics"{if q.Room!="main"{failHTTP(w,403,"ROOM_REQUIRED");return};reply(w,200,map[string]any{"protocolVersion":1,"retentionSeconds":300,"attempts":a.rtcDiagnostics.snapshot()});return}
 count,present:=a.backend.Hub.HostSummary("main",q.PeerID)
 result:=map[string]any{"protocolVersion":1,"roomId":"main","name":a.cfg.DeviceName,"online":a.Online(),"activeInstances":count,"currentPiInRoom":present&&q.Room=="main","visitorRole":"operator"}
 if q.Operation=="share" {key,revision:=a.room.snapshot();result["roomKey"]=key;result["url"]=strings.TrimSuffix(a.cfg.PublicOrigin,"/")+"/#/room/"+key;result["revision"]=revision}
 reply(w,200,result)
}
