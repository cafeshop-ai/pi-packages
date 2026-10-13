package protocol

import (
	"reflect"
	"strings"
	"testing"
)

func TestUnknownDeepJSONWithoutNewDepthLimit(t *testing.T) {
	raw := `{"type":"error","code":"X","message":"x","unknown":` + strings.Repeat("[", 60000) + "null" + strings.Repeat("]", 60000) + "}"
	out, e := DecodeWire([]byte(raw))
	if e != nil {
		t.Fatal(e)
	}
	if len(out) != 3 {
		t.Fatal("unknown retained")
	}
}
func TestMalformedJSONGrammar(t *testing.T) {
	for _, s := range []string{`[1,]`, `{"a":1,}`, `{"a" 1}`, `[01]`, `[+1]`, `[.1]`, `[1.]`, `[1e]`, `[1e+]`, `[tru]`, `[nul]`, `{"a":"\x01"}`, `"\uZZZZ"`, `"a`} {
		if _, e := parseJSON([]byte(s)); e == nil {
			t.Errorf("accepted invalid JSON %s", s)
		}
	}
}
func TestJSFloatEncoding(t *testing.T) {
	for _, tc := range []struct {
		n float64
		s string
	}{{1e-7, "1e-7"}, {1e-6, "0.000001"}, {1e20, "100000000000000000000"}, {1e21, "1e+21"}, {1.7976931348623157e308, "1.7976931348623157e+308"}} {
		b, e := stringify(tc.n)
		if e != nil || string(b) != tc.s {
			t.Errorf("%g -> %s / %v", tc.n, b, e)
		}
	}
}
func TestSurrogateAcrossDeltaAndImmutability(t *testing.T) {
	values := fixtureRead(t, "values.json").(Object)
	snapshot := expandFixture(t, values["snapshot"], values).(Object)
	message := expandFixture(t, values["message"], values).(Object)
	message["text"] = fromUnits([]uint16{0xd83d})
	snapshot["messages"] = []any{message}
	before, _ := stringify(snapshot)
	e := Object{"type": "event", "streamId": "s1", "sessionId": "session1", "seq": float64(1), "event": Object{"kind": "message_delta", "messageId": "m1", "channel": "text", "delta": fromUnits([]uint16{0xde42})}}
	out, err := ApplyEvent(snapshot, e)
	if err != nil {
		t.Fatal(err)
	}
	if out["messages"].([]any)[0].(Object)["text"] != "🙂" {
		t.Fatal("surrogate pair not joined")
	}
	after, _ := stringify(snapshot)
	if string(before) != string(after) {
		t.Fatal("mutated input")
	}
	out["messages"].([]any)[0].(Object)["text"] = "changed"
	if reflect.DeepEqual(snapshot, out) {
		t.Fatal("aliased snapshot")
	}
}
func TestFitCycleAndEnvelopeBounds(t *testing.T) {
	cyc := Object{}
	cyc["self"] = cyc
	result := FitCommandResult(Object{"type": "command_result", "requestId": "r", "status": "applied", "code": nil, "message": nil, "data": cyc})
	if result["code"] != "RESULT_TOO_LARGE" {
		t.Fatal(result)
	}
}
