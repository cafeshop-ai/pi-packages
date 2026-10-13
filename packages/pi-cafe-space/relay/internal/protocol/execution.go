package protocol

import "regexp"

var executionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ValidExecution matches the optional TypeScript wire contract. No free-form
// error, title, token, or terminal bytes are admitted into execution metadata.
func ValidExecution(v any) bool {
 o,ok:=v.(Object);if !ok||o["version"]!=float64(1){return false}
 id,present:=o["runId"];if !present{return false};if id!=nil{s,ok:=id.(string);if !ok||!executionID.MatchString(s){return false}}
 if !one(o["activity"],"idle","working","waiting","compacting","retrying")||!one(o["outcome"],"none","completed","aborted","error","unknown"){return false}
 if o["outcome"]!="none"&&(o["activity"]!="idle"||id==nil){return false}
 if k,ok:=o["waitKind"];ok&&(o["activity"]!="waiting"||!promptKind(k)){return false}
 if reason,ok:=o["reason"];ok&&(o["activity"]!="compacting"||!one(reason,"manual","threshold","overflow")){return false}
 if attempt,ok:=o["attempt"];ok&&(o["activity"]!="retrying"||!integer(attempt,10000)||attempt.(float64)<1){return false}
 if maximum,ok:=o["maxAttempts"];ok{attempt,has:=o["attempt"];if !has||!integer(maximum,10000)||maximum.(float64)<attempt.(float64){return false}}
 if delay,ok:=o["delayMs"];ok&&(o["activity"]!="retrying"||!integer(delay,86400000)){return false}
 return true
}
func promptKind(v any)bool{return one(v,"select","confirm","input","editor","custom")}
func CanonicalExecution(o Object) Object {return selectFields(o,"version","runId","activity","outcome","waitKind","reason","attempt","maxAttempts","delayMs")}
