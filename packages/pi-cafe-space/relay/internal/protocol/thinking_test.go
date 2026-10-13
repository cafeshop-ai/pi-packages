package protocol
import("reflect";"testing")
func TestThinkingMetadataProjection(t *testing.T){
 safe:=Object{"provider":"cafeshop","id":"gemini-3.8-flash","reasoning":true,"thinkingLevels":[]any{"off","low","high"}}
 raw:=cloneTestModel(safe);raw["apiKey"]="must-not-leak";raw["headers"]=Object{"secret":"omitted"};if !model(raw){t.Fatal("valid capability rejected")};if !reflect.DeepEqual(canonicalModel(raw),safe){t.Fatal("capability lost or unrelated fields retained")}
 for _,levels:=range [][]any{{},{"low","low"},{"unknown"},{1},{"high","off"}}{m:=Object{"provider":"x","id":"y","reasoning":false,"thinkingLevels":levels};if model(m){t.Fatal("invalid model capability accepted",levels)}}
 if !model(Object{"provider":"x","id":"y"})||!model(Object{"provider":"x","id":"y","reasoning":false,"thinkingLevels":[]any{"off"}}){t.Fatal("legacy or disabled metadata rejected")}
}
func cloneTestModel(value Object)Object{out:=Object{};for key,v:=range value{out[key]=v};return out}
