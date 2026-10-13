package hub

import (
	"encoding/json"
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"
	"time"
)

func readFixture(t *testing.T, name string) any {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("../../../protocol/fixtures/v1", name))
	if e != nil {
		t.Fatal(e)
	}
	var v any
	if e = json.Unmarshal(b, &v); e != nil {
		t.Fatal(e)
	}
	return fixtureObjects(v)
}
func fixtureObjects(v any) any {
	switch x := v.(type) {
	case map[string]any:
		o := O{}
		for k, v := range x {
			o[k] = fixtureObjects(v)
		}
		return o
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = fixtureObjects(v)
		}
		return a
	}
	return v
}
func expand(v any, values O) any {
	switch x := v.(type) {
	case O:
		if len(x) == 1 {
			if ref, ok := x["$ref"].(string); ok {
				return expand(values[ref], values)
			}
			if merge, ok := x["$merge"].([]any); ok {
				out := O{}
				for _, item := range merge {
					for k, v := range expand(item, values).(O) {
						out[k] = v
					}
				}
				return out
			}
		}
		out := O{}
		for k, v := range x {
			out[k] = expand(v, values)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = expand(v, values)
		}
		return out
	}
	return v
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func matchTrace(t *testing.T, want, got any, bindings O) {
	t.Helper()
	if x, ok := want.(O); ok {
		if ref, ok := x["$bind"].(string); ok {
			value, ok := got.(string)
			if !ok || !uuid.MatchString(value) {
				t.Fatalf("invalid generated ID %v", got)
			}
			if old, exists := bindings[ref]; exists {
				if old != value {
					t.Fatal("binding changed")
				}
			} else {
				for _, v := range bindings {
					if v == value {
						t.Fatal("duplicate generated ID")
					}
				}
				bindings[ref] = value
			}
			return
		}
		y, ok := got.(O)
		if !ok || len(x) != len(y) {
			t.Fatalf("keys want %v, got %v", want, got)
		}
		for k, v := range x {
			value, ok := y[k]
			if !ok {
				t.Fatalf("missing key %s", k)
			}
			matchTrace(t, v, value, bindings)
		}
		return
	}
	if x, ok := want.([]any); ok {
		y, ok := got.([]any)
		if !ok || len(x) != len(y) {
			t.Fatalf("array want %v got %v", want, got)
		}
		for i, v := range x {
			matchTrace(t, v, y[i], bindings)
		}
		return
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("want %#v got %#v", want, got)
	}
}
func TestFrozenHostTraces(t *testing.T) {
	names := []string{"auth-and-role", "duplicate-event-disconnect", "snapshot-required-timeout", "stale-snapshot", "client-generation-retry", "command-timeout", "history-cache-dedupe-offline", "history-result-binding-revision", "host-replacement-readiness", "multi-host-selection", "offline-cache-inactivity", "room-isolation", "target-and-cwd-fences", "write-cannot-poison-history"}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			h, clock := makeHub(t)
			values := readFixture(t, "values.json").(O)
			bindings := O{}
			trace := readFixture(t, "traces/"+name+".json").(O)
			peers := map[string]*Connection{}
			outputs := map[string]*fakeSender{}
			for index, raw := range trace["steps"].([]any) {
				step := raw.(O)
				peer, _ := step["peer"].(string)
				action := step["action"].(string)
				t.Logf("step %d %s %s", index, action, peer)
				refs := copyObject(values)
				for k, v := range bindings {
					refs[k] = v
				}
				switch action {
				case "connect":
					f := &fakeSender{}
					c, e := h.Join(f, "127.0.0.1")
					if e != nil {
						t.Fatal(e)
					}
					peers[peer] = c
					outputs[peer] = f
				case "send":
					b, e := protocol.ValueBytes(expand(step["message"], refs))
					if e != nil {
						t.Fatal(e)
					}
					if e = h.Handle(peers[peer], b); e != nil {
						t.Fatal(e)
					}
				case "receive":
					f := outputs[peer]
					f.mu.Lock()
					var got O
					if len(f.messages) > 0 {
						got = f.messages[0]
						f.messages = f.messages[1:]
					}
					f.mu.Unlock()
					if got == nil {
						t.Fatalf("step %d missing message", index)
					}
					matchTrace(t, expand(step["message"], refs), got, bindings)
				case "expectClose":
					f := outputs[peer]
					f.mu.Lock()
					closed, code, reason := f.closed, f.code, f.reason
					f.mu.Unlock()
					if !closed || float64(code) != step["code"] || reason != step["reason"] {
						t.Fatalf("close: %v %d %s want %v", closed, code, reason, step)
					}
				case "close":
					h.Leave(peers[peer])
				case "advance":
					clock.advance(time.Duration(step["ms"].(float64)) * time.Millisecond)
				default:
					t.Fatal("unimplemented trace action", action)
				}
				h.Sync()
				// Model transport close callback separately from the room's close request.
				for id, f := range outputs {
					f.mu.Lock()
					closed := f.closed
					f.mu.Unlock()
					if closed {
						h.Leave(peers[id])
					}
				}
				h.Sync()
			}
			for id, f := range outputs {
				if messages := f.drain(); len(messages) > 0 {
					t.Fatal(fmt.Sprintf("unconsumed FIFO %s: %v", id, messages))
				}
			}
			h.Close()
			if s := h.Stats(); s.Bytes != 0 || s.Rooms != 0 || s.Connections != 0 {
				t.Fatal("cleanup", s)
			}
		})
	}
}
