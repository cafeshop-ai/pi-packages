package managed

import (
 "encoding/json"
 "os"
 "path/filepath"
 "strings"
 "testing"
)
func feedExecution(t *testing.T,r *rpcExecution,raw string){t.Helper();var event rpcEvent;if err:=json.Unmarshal([]byte(raw),&event);err!=nil{t.Fatal(err)};r.observe(event)}
func TestRPCExecutionRetrySettlement(t *testing.T){
 r:=rpcExecution{};feedExecution(t,&r,`{"type":"agent_start"}`);id:=r.snapshot()["runId"]
 feedExecution(t,&r,`{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}`)
 feedExecution(t,&r,`{"type":"agent_end","willRetry":true}`);if r.snapshot()["outcome"]!="none"{t.Fatal("low-level end settled too early")}
 feedExecution(t,&r,`{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":5,"errorMessage":"secret must never leave status"}`)
 s:=r.snapshot();if s["activity"]!="retrying"||s["outcome"]!="none"{t.Fatal(s)};raw,_:=json.Marshal(s);if strings.Contains(string(raw),"secret"){t.Fatal("raw error leaked")}
 feedExecution(t,&r,`{"type":"agent_start"}`);if r.snapshot()["runId"]!=id{t.Fatal("retry changed run")};feedExecution(t,&r,`{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}`);feedExecution(t,&r,`{"type":"auto_retry_end","success":true,"attempt":1}`)
 if r.snapshot()["outcome"]!="none"{t.Fatal("retry completion is not settlement")};feedExecution(t,&r,`{"type":"agent_settled","aborted":false}`);if r.snapshot()["outcome"]!="completed"{t.Fatal(r.snapshot())}
 feedExecution(t,&r,`{"type":"agent_start"}`);if r.snapshot()["runId"]==id{t.Fatal("new run reused ID")};feedExecution(t,&r,`{"type":"auto_retry_end","success":false}`);feedExecution(t,&r,`{"type":"agent_settled","aborted":true}`);if r.snapshot()["outcome"]!="aborted"{t.Fatal("cancelled retry shown as failure")}
}
func TestRPCExecutionCompactionUnknownAndInput(t *testing.T){
 r:=rpcExecution{};feedExecution(t,&r,`{"type":"compaction_start","reason":"manual"}`);if r.snapshot()["activity"]!="compacting"{t.Fatal(r.snapshot())};feedExecution(t,&r,`{"type":"compaction_end","reason":"manual","aborted":true}`);if r.snapshot()["outcome"]!="none"||r.snapshot()["activity"]!="idle"{t.Fatal("manual cancellation invented run result")}
 feedExecution(t,&r,`{"type":"agent_start"}`);feedExecution(t,&r,`{"type":"ui_prompt_start","kind":"input"}`);if r.snapshot()["waitKind"]!="input"{t.Fatal(r.snapshot())};feedExecution(t,&r,`{"type":"ui_prompt_end","kind":"input"}`);feedExecution(t,&r,`{"type":"agent_settled"}`);if r.snapshot()["outcome"]!="unknown"{t.Fatal("missing final data reported success")}
 feedExecution(t,&r,`{"type":"agent_start"}`);feedExecution(t,&r,`{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}`);feedExecution(t,&r,`{"type":"compaction_start","reason":"overflow"}`);feedExecution(t,&r,`{"type":"compaction_end","reason":"overflow","errorMessage":"failed","willRetry":false}`);feedExecution(t,&r,`{"type":"agent_settled","aborted":false}`);if r.snapshot()["outcome"]!="error"{t.Fatal("final compaction error lost")}
}
func TestRPCExecutionOnlyInventoryCopiesAndNoRestartCarry(t *testing.T){
 p:=&process{ready:true};feedExecution(t,&p.execution,`{"type":"agent_start"}`)
 m:=&Manager{cfg:Config{StateDir:t.TempDir()},records:[]Record{{ID:"one",Room:"main",Status:"ready"}},active:map[string]*process{"one":p}}
 read:=func(room string)[]Record{return m.inventory(room).(map[string]any)["sessions"].([]Record)}
 if len(read("other"))!=0{t.Fatal("cross-room leak")};record:=read("main")[0];if record.Execution==nil{t.Fatal("observation missing")};record.Execution["activity"]="idle";if p.execution.snapshot()["activity"]!="working"{t.Fatal("snapshot alias")}
 if m.records[0].Execution!=nil{t.Fatal("runtime polluted registry")};if err:=m.save();err!=nil{t.Fatal(err)};raw,_:=os.ReadFile(filepath.Join(m.cfg.StateDir,"registry.json"));if strings.Contains(string(raw),"execution"){t.Fatal("runtime persisted")};delete(m.active,"one");if read("main")[0].Execution!=nil{t.Fatal("closed process still reported live")}
 r:=rpcExecution{};if r.snapshot()!=nil{t.Fatal("new process inherited status")};feedExecution(t,&r,`{"type":"auto_retry_start","attempt":0,"maxAttempts":3}`);if r.snapshot()!=nil{t.Fatal("malformed retry changed status")};var event rpcEvent;if json.Unmarshal([]byte("\x1b]7501;working\x07"),&event)==nil{t.Fatal("OSC treated as JSON")}
}
