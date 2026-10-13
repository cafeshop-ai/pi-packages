package protocol

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixtureRead(t *testing.T, name string) any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../../../protocol/fixtures/v1", name))
	if err != nil {
		t.Fatal(err)
	}
	v, err := parseJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func expandFixture(t *testing.T, v any, values Object) any {
	t.Helper()
	if a, ok := v.([]any); ok {
		out := make([]any, len(a))
		for i, x := range a {
			out[i] = expandFixture(t, x, values)
		}
		return out
	}
	o, ok := v.(Object)
	if !ok {
		return v
	}
	if len(o) == 1 {
		if name, ok := o["$ref"].(string); ok {
			x, exists := values[name]
			if !exists {
				t.Fatalf("unknown reference %s", name)
			}
			return expandFixture(t, x, values)
		}
		if x, ok := o["$repeat"].(Object); ok {
			return strings.Repeat(x["text"].(string), int(x["count"].(float64)))
		}
		if x, ok := o["$array"].(Object); ok {
			a := make([]any, int(x["count"].(float64)))
			for i := range a {
				a[i] = expandFixture(t, x["value"], values)
			}
			return a
		}
		if x, ok := o["$object"].(Object); ok {
			a := Object{}
			for i := 0; i < int(x["count"].(float64)); i++ {
				a[fmt.Sprintf("k%d", i)] = expandFixture(t, x["value"], values)
			}
			return a
		}
		if x, ok := o["$nest"].(Object); ok {
			a := expandFixture(t, x["value"], values)
			for i := 0; i < int(x["depth"].(float64)); i++ {
				a = []any{a}
			}
			return a
		}
		if a, ok := o["$merge"].([]any); ok {
			out := Object{}
			for _, x := range a {
				for k, v := range expandFixture(t, x, values).(Object) {
					out[k] = v
				}
			}
			return out
		}
	}
	out := Object{}
	for k, x := range o {
		out[k] = expandFixture(t, x, values)
	}
	return out
}
func TestFrozenFixtures(t *testing.T) {
	values := fixtureRead(t, "values.json").(Object)
	count := 0
	for _, name := range []string{"codec.json", "reducer.json", "budgets.json", "session-controls.json", "input-assist.json"} {
		for _, raw := range fixtureRead(t, name).([]any) {
			f := raw.(Object)
			count++
			t.Run(f["id"].(string), func(t *testing.T) {
				expected := f["expected"].(Object)
				expand := func(v any) any { return expandFixture(t, v, values) }
				var got any
				var err error
				switch f["operation"] {
				case "decode", "encode":
					var input []byte
					if text, ok := f["inputText"].(string); ok {
						input = []byte(text)
					} else if text, ok := f["inputBase64"].(string); ok {
						input, err = base64.StdEncoding.DecodeString(text)
						if err != nil {
							t.Fatal(err)
						}
						input = stripBOM(input)
					} else {
						input, err = stringify(expand(f["inputTemplate"]))
						if err != nil {
							t.Fatal(err)
						}
					}
					if size, ok := f["paddingBytes"].(float64); ok {
						input = append(input, strings.Repeat(" ", int(size)-len(input))...)
					}
					got, err = DecodeWire(input)
					if err == nil && f["operation"] == "encode" {
						var encoded []byte
						encoded, err = EncodeWire(got.(Object))
						if n, ok := expected["bytes"].(float64); ok && len(encoded) != int(n) {
							t.Fatalf("encoded size %d != %v", len(encoded), n)
						}
					}
				case "fitCommandResult":
					got = FitCommandResult(expand(f["input"]).(Object))
				case "applyEvent":
					got, err = ApplyEvent(expand(f["snapshot"]).(Object), expand(f["envelope"]).(Object))
				default:
					t.Fatalf("unknown fixture operation %v", f["operation"])
				}
				if expected["accepted"] == true {
					if err != nil {
						t.Fatal(err)
					}
					want := expand(expected["value"])
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("value mismatch\ngot %.1500v\nwant %.1500v", got, want)
					}
				} else {
					if err == nil {
						t.Fatal("expected rejection")
					}
					if code, ok := expected["code"].(string); ok {
						e, ok := err.(*DecodeError)
						if !ok || e.Code != code {
							t.Fatalf("expected code %s, got %v", code, err)
						}
					}
					if message, ok := expected["error"].(string); ok && err.Error() != message {
						t.Fatalf("error %q != %q", err.Error(), message)
					}
				}
			})
		}
	}
	if count != 328 {
		t.Fatalf("fixture inventory changed: %d", count)
	}
}
func TestJSONSurrogatesAndNumbers(t *testing.T) {
	for _, text := range []string{`"\ud800"`, `"\udc00"`, `"\ud800\udc00"`, `"<>&\n"`, `{"__proto__":false,"n":1e400}`, `[9007199254740993,-0,1e-7,1e20,1e21]`} {
		v, err := parseJSON([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := stringify(v)
		if err != nil && !strings.Contains(text, "1e400") {
			t.Fatal(err)
		}
		if err == nil {
			again, err := parseJSON(encoded)
			if err != nil || !reflect.DeepEqual(v, again) {
				t.Fatalf("JSON round trip %s: %v", text, err)
			}
		}
	}
}
func FuzzDecodeWire(f *testing.F) {
	f.Add([]byte(`{"type":"event","streamId":"s","sessionId":"session","seq":1,"emittedAt":"now","event":{"kind":"message_delta","messageId":"m","channel":"text","delta":"hello","partIndex":0}}`))
	f.Add([]byte(`{"type":"event","streamId":"s","sessionId":"session","seq":1,"emittedAt":"now","event":{"kind":"message_started","message":{"id":"m","role":"assistant","text":"","thinking":"","timestamp":1,"status":"streaming","toolName":null,"toolCallId":null,"parts":[],"partsTruncated":false}}}`))
	for _, seed := range []string{`{"type":"error","code":"X","message":"hello"}`, `{"type":"hello","protocolVersion":1,"peerRole":"host","peerId":"h","roomId":"r","token":"t"}`, `{"type":"command_result","requestId":"r","status":"applied","code":null,"message":null,"data":"\ud800"}`, `{}`, `null`, string([]byte{255})} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		value, err := DecodeWire(b)
		if err != nil {
			return
		}
		encoded, err := EncodeWire(value)
		if err != nil {
			t.Fatal(err)
		}
		again, err := DecodeWire(encoded)
		if err != nil || !reflect.DeepEqual(value, again) {
			t.Fatalf("canonical roundtrip: %v", err)
		}
	})
}
