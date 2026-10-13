package remote

import (
 "fmt"
 "strings"
 "sync"
 "time"
 "github.com/pion/logging"
)

const rtcDiagnosticRetention = 5*time.Minute
const rtcDiagnosticAttempts = 24
const rtcDiagnosticEvents = 32

type rtcDiagnosticEvent struct {
 Milliseconds int64 `json:"ms"`
 Step string `json:"step"`
 State string `json:"state"`
}
type rtcDiagnosticView struct {
 Number uint64 `json:"number"`
 AgeSeconds int64 `json:"ageSeconds"`
 Events []rtcDiagnosticEvent `json:"events"`
}
type rtcAttempt struct { mu sync.Mutex; number uint64; started time.Time; events []rtcDiagnosticEvent }
type rtcDiagnostics struct { mu sync.Mutex; next uint64; attempts []*rtcAttempt }
func(d *rtcDiagnostics) begin()*rtcAttempt {
 d.mu.Lock();defer d.mu.Unlock();now:=time.Now();d.next++
 a:=&rtcAttempt{number:d.next,started:now,events:make([]rtcDiagnosticEvent,0,rtcDiagnosticEvents)}
 kept:=make([]*rtcAttempt,0,rtcDiagnosticAttempts)
 for _,old:=range d.attempts{if now.Sub(old.started)<rtcDiagnosticRetention{kept=append(kept,old)}}
 if len(kept)>=rtcDiagnosticAttempts{kept=kept[len(kept)-rtcDiagnosticAttempts+1:]}
 d.attempts=append(kept,a);return a
}
func(d *rtcDiagnostics) prune(now time.Time){
 d.mu.Lock();defer d.mu.Unlock();kept:=d.attempts[:0]
 for _,a:=range d.attempts{if now.Sub(a.started)<rtcDiagnosticRetention{kept=append(kept,a)}else{a.mu.Lock();a.events=nil;a.mu.Unlock()}}
 for i:=len(kept);i<len(d.attempts);i++{d.attempts[i]=nil};d.attempts=kept
}
func(d *rtcDiagnostics) snapshot()[]rtcDiagnosticView {
 d.mu.Lock();defer d.mu.Unlock();now:=time.Now();out:=[]rtcDiagnosticView{}
 kept:=d.attempts[:0]
 for _,a:=range d.attempts{if now.Sub(a.started)>=rtcDiagnosticRetention{continue};kept=append(kept,a);a.mu.Lock();events:=append([]rtcDiagnosticEvent(nil),a.events...);a.mu.Unlock();out=append(out,rtcDiagnosticView{a.number,int64(now.Sub(a.started)/time.Second),events})}
 for i:=len(kept);i<len(d.attempts);i++{d.attempts[i]=nil};d.attempts=kept;return out
}
func(a *rtcAttempt) add(step,state string){
 if a==nil{return}
 switch step{case "session","handshake","ice","peer","dtls","sctp-error","sctp-close","data","data-error","policy","selection","close","pion-sctp","pion-dtls","pion-transport","pion-data":default:return}
 switch state{case "ROOM_VERIFIED","HELLO_RECEIVED","HELLO_ACCEPTED","created","new","checking","connecting","connected","completed","disconnected","failed","closed","received","open","requested","selected","LABEL_REJECTED","PROTOCOL_REJECTED","RELIABILITY_REJECTED","DUPLICATE_CHANNEL","PEER_ABORT","TIMEOUT","EOF","CLOSED","CHECKSUM","CERTIFICATE","BUFFER_LIMIT","HANDSHAKE","OTHER_ERROR","NONE","VISITOR_LEFT","SIGNAL_LOST","AUTH_EXPIRED","PASSWORD_REJECTED","ROOM_CHANGED","INVALID_SELECTION","INVALID_MESSAGE","QUEUE_LIMIT","READ_STOPPED","WRITE_STOPPED","TRANSPORT_CLOSED","DEVICE_STOPPED","OTHER_CLOSE":default:state="OTHER_ERROR"}
 a.mu.Lock();defer a.mu.Unlock();if time.Since(a.started)>=rtcDiagnosticRetention{return}
 if n:=len(a.events);n>0&&a.events[n-1].Step==step&&a.events[n-1].State==state{return}
 if len(a.events)>=rtcDiagnosticEvents{copy(a.events[1:],a.events[2:]);a.events=a.events[:rtcDiagnosticEvents-1]};a.events=append(a.events,rtcDiagnosticEvent{time.Since(a.started).Milliseconds(),step,state})
}
func rtcErrorClass(err error)string{if err==nil{return "NONE"};return rtcErrorTextClass(err.Error())}
func rtcErrorTextClass(message string)string{
 if len(message)>2048{message=message[:2048]};m:=strings.ToLower(message)
 for _,p:=range []struct{term,code string}{{"abort","PEER_ABORT"},{"timed out","TIMEOUT"},{"timeout","TIMEOUT"},{"deadline","TIMEOUT"},{"checksum","CHECKSUM"},{"certificate","CERTIFICATE"},{"fingerprint","CERTIFICATE"},{"buffer","BUFFER_LIMIT"},{"eof","EOF"},{"closed","CLOSED"},{"handshake","HANDSHAKE"}}{if strings.Contains(m,p.term){return p.code}}
 return "OTHER_ERROR"
}
func rtcCloseClass(reason string)string{
 switch reason{
 case "Browser disconnected","Visitor disconnected":return "VISITOR_LEFT"
 case "Cloud connection lost","Room signaling disconnected":return "SIGNAL_LOST"
 case "Remote authorization expired":return "AUTH_EXPIRED"
 case "Room password rejected":return "PASSWORD_REJECTED"
 case "Room access changed":return "ROOM_CHANGED"
 case "Invalid transport selection","P2P transport required":return "INVALID_SELECTION"
 case "Reliable ordered data channel required":return "RELIABILITY_REJECTED"
 case "Only one data channel is allowed":return "DUPLICATE_CHANNEL"
 case "Invalid DataChannel message","Invalid data transport","Invalid remote data":return "INVALID_MESSAGE"
 case "Remote input queue full","Remote client is too slow","Local relay capacity exceeded":return "QUEUE_LIMIT"
 case "Remote read stopped":return "READ_STOPPED"
 case "Remote write stopped":return "WRITE_STOPPED"
 case "WebRTC connection lost","DataChannel closed":return "TRANSPORT_CLOSED"
 case "Device connection closed":return "DEVICE_STOPPED"
 default:return "OTHER_CLOSE"
 }
}
// No raw Pion messages are retained. Only selected warning/error categories
// enter the bounded in-memory trace; all packet/debug/credential text is dropped.
type rtcTraceLoggerFactory struct{ attempt *rtcAttempt }
func(f rtcTraceLoggerFactory)NewLogger(scope string)logging.LeveledLogger{return rtcTraceLogger{f.attempt,scope}}
type rtcTraceLogger struct{attempt *rtcAttempt;scope string}
func(l rtcTraceLogger)Trace(string){};func(l rtcTraceLogger)Tracef(string,...any){}
func(l rtcTraceLogger)Debug(string){};func(l rtcTraceLogger)Debugf(string,...any){}
func(l rtcTraceLogger)Info(string){};func(l rtcTraceLogger)Infof(string,...any){}
func(l rtcTraceLogger)Warn(m string){l.record(m)};func(l rtcTraceLogger)Warnf(f string,a ...any){l.record(fmt.Sprintf(f,a...))}
func(l rtcTraceLogger)Error(m string){l.record(m)};func(l rtcTraceLogger)Errorf(f string,a ...any){l.record(fmt.Sprintf(f,a...))}
func(l rtcTraceLogger)record(m string){
 switch l.scope{case "sctp":l.attempt.add("pion-sctp",rtcErrorTextClass(m));case "dtls":l.attempt.add("pion-dtls",rtcErrorTextClass(m));case "datachannel":l.attempt.add("pion-data",rtcErrorTextClass(m));case "pc":if strings.Contains(m,"Failed to start SCTP"){l.attempt.add("pion-sctp",rtcErrorTextClass(m))}else if strings.Contains(m,"Failed to start manager"){l.attempt.add("pion-transport",rtcErrorTextClass(m))}}
}
