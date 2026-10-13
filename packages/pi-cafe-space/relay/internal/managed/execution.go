package managed

import (
 "fmt"
 "time"

 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
)

// Only structured RPC fields are decoded. No error messages, login answers,
// stdout scraping or OSC sequences are used to derive these observations.
type rpcMessage struct { Role string `json:"role"`; StopReason string `json:"stopReason"` }
type rpcEvent struct {
 Type string `json:"type"`; ID string `json:"id"`; Method string `json:"method"`; Success bool `json:"success"`
 Aborted *bool `json:"aborted"`; ErrorMessage string `json:"errorMessage"`; Reason string `json:"reason"`; Kind string `json:"kind"`; WillRetry bool `json:"willRetry"`
 Attempt int `json:"attempt"`; MaxAttempts int `json:"maxAttempts"`; DelayMS int `json:"delayMs"`
 Message rpcMessage `json:"message"`; Messages []rpcMessage `json:"messages"`
 Data struct { SessionID string `json:"sessionId"`; SessionName string `json:"sessionName"` } `json:"data"`
}
type rpcExecution struct { state protocol.Object; active bool; serial uint64; prefix string; last string; compact bool }
func (r *rpcExecution) begin() {
 if !r.active {r.serial++;if r.prefix==""{r.prefix=fmt.Sprintf("rpc-%x",time.Now().UnixNano())};r.state=protocol.Object{"version":float64(1),"runId":fmt.Sprintf("%s-%d",r.prefix,r.serial),"activity":"working","outcome":"none"}}
 r.active=true;r.last="";r.activity("working",nil)
}
func (r *rpcExecution) activity(activity string,extras protocol.Object) {
 var id any;if r.state!=nil{id=r.state["runId"]}
 r.state=protocol.Object{"version":float64(1),"runId":id,"activity":activity,"outcome":"none"}
 for key,v:=range extras{r.state[key]=v}
}
func (r *rpcExecution) message(message rpcMessage) {
 if !r.active||message.Role!="assistant"{return}
 switch message.StopReason {case "stop","length":r.last="completed";case "error":r.last="error";case "aborted":r.last="aborted";default:r.last=""}
}
func (r *rpcExecution) observe(event rpcEvent) {
 switch event.Type {
 case "agent_start":r.begin()
 case "message_start":if event.Message.Role=="assistant"{if !r.active{r.begin()};r.last="";r.activity("working",nil)}
 case "message_end":r.message(event.Message)
 case "agent_end":
  for _,message:=range event.Messages{r.message(message)}
  // agent_end can still be followed by retry, compaction or queued work.
  if r.active {r.activity("working",nil)}
 case "auto_retry_start":
  if event.Attempt<1||event.Attempt>10000||event.MaxAttempts<event.Attempt||event.MaxAttempts>10000||event.DelayMS<0||event.DelayMS>86400000{return}
  if !r.active{r.begin()}
  r.activity("retrying",protocol.Object{"attempt":float64(event.Attempt),"maxAttempts":float64(event.MaxAttempts),"delayMs":float64(event.DelayMS)})
 case "auto_retry_end":
  if !r.active{return};if !event.Success {r.last="error"};r.activity("working",nil)
 case "compaction_start":
  if event.Reason!="manual"&&event.Reason!="threshold"&&event.Reason!="overflow"{return};r.compact=true;r.activity("compacting",protocol.Object{"reason":event.Reason})
 case "compaction_end":
  r.compact=false;if r.active{if !event.WillRetry&&event.ErrorMessage!=""&&(event.Aborted==nil||!*event.Aborted){r.last="error"};r.activity("working",nil)}else{r.activity("idle",nil)}
 case "ui_prompt_start":
  switch event.Kind{case "confirm","select","input","editor","custom":r.activity("waiting",protocol.Object{"waitKind":event.Kind})}
 case "ui_prompt_end":
  if r.active{r.activity("working",nil)}else{r.activity("idle",nil)}
 case "agent_settled":
  if !r.active&&r.state!=nil&&r.state["outcome"]!="none"{return}
  if r.state==nil||r.state["runId"]==nil{r.begin()}
  outcome:=r.last;if event.Aborted!=nil&&*event.Aborted{outcome="aborted"};if outcome==""{outcome="unknown"}
  r.activity("idle",nil);r.state["outcome"]=outcome;r.active=false;r.compact=false;r.last=""
 }
}
func (r *rpcExecution) snapshot() protocol.Object {
 if r.state==nil||!protocol.ValidExecution(r.state){return nil}
 return protocol.CanonicalExecution(r.state)
}
