package protocol

import (
 "reflect"
 "testing"
)
func TestExecutionLifecycleSharedWithTypeScript(t *testing.T){
 f:=fixtureRead(t,"../execution/lifecycle.json").(Object);s:=f["initial"].(Object)
 for _,raw:=range f["events"].([]any){bytes,_:=stringify(raw);event,err:=DecodeWire(bytes);if err!=nil{t.Fatal(err)};before,_:=stringify(s);next,err:=ApplyEvent(s,event);if err!=nil{t.Fatal(err)};after,_:=stringify(s);if string(before)!=string(after){t.Fatal("mutated prior snapshot")};s=next}
 if !reflect.DeepEqual(s,f["expectedFinal"]){t.Fatal("state differs from TS fixture",s)}
 raw,err:=EncodeWire(Object{"type":"snapshot","hostId":"host-a","snapshot":s});if err!=nil{t.Fatal(err)};decoded,err:=DecodeWire(raw);if err!=nil||!reflect.DeepEqual(decoded["snapshot"],s){t.Fatal("reconnect lost outcome",err)}
 legacy:=Object{"streamId":"stream-a","sessionId":"session-a","seq":float64(6),"event":Object{"kind":"session_state","phase":"idle","hasPendingMessages":false}}
 next,err:=ApplyEvent(s,legacy);if err!=nil{t.Fatal(err)};if _,exists:=next["execution"];exists{t.Fatal("legacy event kept stale outcome")}
}
func TestExecutionValidationAndProjection(t *testing.T){
 base:=Object{"version":float64(1),"runId":"turn-a","activity":"working","outcome":"none"}
 invalid:=[]Object{{"version":float64(2)},{"runId":"bad\n"},{"outcome":"completed"},{"activity":"idle","runId":nil,"outcome":"completed"},{"waitKind":"confirm"},{"activity":"waiting","waitKind":"arbitrary"},{"activity":"retrying","attempt":float64(0)},{"activity":"retrying","attempt":float64(3),"maxAttempts":float64(2)},{"activity":"retrying","delayMs":float64(86400001)},{"activity":"compacting","reason":"arbitrary"}}
 for _,changes:=range invalid{value:=CanonicalExecution(base);for key,v:=range changes{value[key]=v};if ValidExecution(value){t.Fatal("invalid execution accepted",value)}}
 raw:=CanonicalExecution(base);raw["token"]="not-forwarded";raw["errorMessage"]="not-forwarded";if !ValidExecution(raw)||!reflect.DeepEqual(CanonicalExecution(raw),base){t.Fatal("whitelist failed")}
 event:=Object{"kind":"session_state","phase":"running","hasPendingMessages":false,"execution":raw};out:=canonicalEvent(event);out["execution"].(Object)["activity"]="idle";if raw["activity"]!="working"{t.Fatal("mutable state alias")}
}
