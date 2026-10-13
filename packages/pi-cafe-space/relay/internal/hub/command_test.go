package hub

import (
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"strings"
	"sync"
	"testing"
	"time"
)

func command(id, name string) O {
	payload := O{"name": name}
	if name == "get_session" {
		payload["sessionId"] = "history"
	}
	return O{"type": "command", "requestId": id, "targetHostId": "h", "expectedStreamId": "s", "expectedSessionId": "session", "expectedCwd": "C:/test", "payload": payload}
}
func setupCommands(t *testing.T) (*Hub, *fakeClock, *Connection, *fakeSender, *Connection, *fakeSender) {
	t.Helper()
	h, clock := makeHub(t)
	c, cf := connect(t, h, "client", "c", "main")
	host, hf := connect(t, h, "host", "h", "main")
	send(t, h, host, O{"type": "snapshot", "snapshot": snapshot("s", "session", 0)})
	cf.drain()
	hf.drain()
	return h, clock, c, cf, host, hf
}
func applied(id string, data any) O {
	o := O{"type": "host_command_result", "relayRequestId": id, "status": "applied", "code": nil, "message": nil}
	if data != nil {
		o["data"] = data
	}
	return o
}
func TestPendingLimitsAndTimeoutRelease(t *testing.T) {
	h, clock, c, cf, _, hf := setupCommands(t)
	for i := 0; i < 32; i++ {
		send(t, h, c, command(fmt.Sprint(i), "abort"))
	}
	if len(hf.drain()) != 32 {
		t.Fatal("not all dispatched")
	}
	send(t, h, c, command("overflow", "abort"))
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "COMMAND_QUEUE_FULL" {
		t.Fatal(got)
	}
	for i := 0; i < 3; i++ {
		other, f := connect(t, h, "client", fmt.Sprint(i), "main")
		f.drain()
		for j := 0; j < 32; j++ {
			send(t, h, other, command(fmt.Sprint(j), "abort"))
		}
	}
	other, f := connect(t, h, "client", "last", "main")
	f.drain()
	send(t, h, other, command("host-overflow", "abort"))
	if got := f.drain(); len(got) != 1 || got[0]["code"] != "COMMAND_QUEUE_FULL" {
		t.Fatal(got)
	}
	clock.advance(15 * time.Second)
	h.Sync()
	got := cf.drain()
	if len(got) != 32 {
		t.Fatal("timeout count", len(got))
	}
	for _, o := range got {
		if o["code"] != "HOST_TIMEOUT" {
			t.Fatal(o)
		}
	}
	send(t, h, c, command("new", "abort"))
	clock.advance(15 * time.Second)
	h.Sync()
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "HOST_TIMEOUT" {
		t.Fatal("pending quota not released", got)
	}
}
func TestRoutedAndResultEnvelopeBudgets(t *testing.T) {
	h, _, c, cf, host, hf := setupCommands(t)
	m := command(strings.Repeat("r", 128), "prompt")
	m["payload"] = O{"name": "prompt", "content": "x"}
	raw, _ := protocol.EncodeWire(m)
	count := (protocol.MaxFrameBytes - len(raw)) / 6
	m["payload"].(O)["content"] = strings.Repeat("\x00", count)
	send(t, h, c, m)
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "COMMAND_TOO_LARGE" {
		t.Fatal("routed budget", got)
	}
	if len(hf.drain()) != 0 {
		t.Fatal("oversized command dispatched")
	}
	send(t, h, c, command(strings.Repeat("r", 128), "abort"))
	route := hf.drain()[0]
	result := applied(route["relayRequestId"].(string), "")
	raw, _ = protocol.EncodeWire(result)
	count = protocol.MaxFrameBytes - len(raw) - 10
	result["data"] = strings.Repeat("x", count)
	send(t, h, host, result)
	got := cf.drain()
	if len(got) != 1 || got[0]["code"] != "RESULT_TOO_LARGE" || got[0]["status"] != "rejected" {
		t.Fatal("result budget", got)
	}
}
func TestProjectionChangesFenceHistoryButNotStateEvents(t *testing.T) {
	h, _, c, cf, host, hf := setupCommands(t)
	send(t, h, c, command("history", "get_session"))
	id := hf.drain()[0]["relayRequestId"].(string)
	send(t, h, host, O{"type": "event", "streamId": "s", "sessionId": "session", "seq": float64(1), "emittedAt": "now", "event": O{"kind": "session_state", "phase": "running", "hasPendingMessages": false}})
	cf.drain()
	send(t, h, host, applied(id, O{"kind": "session", "sessionId": "history"}))
	got := cf.drain()
	if len(got) != 1 || got[0]["status"] != "applied" {
		t.Fatal(got)
	}
	send(t, h, c, command("next", "get_session"))
	id = hf.drain()[0]["relayRequestId"].(string)
	next := snapshot("s", "session", 1)
	next["sessionName"] = "renamed"
	send(t, h, host, O{"type": "snapshot", "snapshot": next})
	got = cf.drain()
	if len(got) != 3 || got[0]["code"] != "STALE_SESSION" {
		t.Fatal("revision rejection before snapshot", got)
	}
	send(t, h, host, applied(id, O{"kind": "session", "sessionId": "history"}))
	if len(cf.drain()) != 0 {
		t.Fatal("late result delivered")
	}
	send(t, h, c, command("next", "get_session"))
	if len(hf.drain()) != 1 {
		t.Fatal("stale rejection incorrectly deduped")
	}
}
func TestClientDisconnectResultDeliveryFence(t *testing.T) {
	h, _, c, _, host, hf := setupCommands(t)
	send(t, h, c, command("r", "abort"))
	route := hf.drain()[0]
	h.Leave(c)
	h.Sync()
	_, next := connect(t, h, "client", "c", "main")
	next.drain()
	send(t, h, host, applied(route["relayRequestId"].(string), nil))
	if len(next.drain()) != 0 {
		t.Fatal("result crossed client generation without retry")
	}
}
func TestCacheCountByteTTLAndRelease(t *testing.T) {
	h, _ := makeHub(t)
	r := newRoom(h, "direct")
	host := &host{id: "h"}
	host.initCommands()
	for i := 0; i < 1001; i++ {
		r.remember(host, fmt.Sprint(i), O{"type": "command_result", "requestId": fmt.Sprint(i), "status": "applied", "code": nil, "message": nil}, false)
	}
	if len(host.results) != 1000 || host.resultOrder[0] != "1" {
		t.Fatal("result count/FIFO")
	}
	large := strings.Repeat("x", 200000)
	for i := 0; i < 60; i++ {
		r.remember(host, fmt.Sprint(i), O{"type": "command_result", "requestId": fmt.Sprint(i), "status": "applied", "code": nil, "message": nil, "data": large}, false)
	}
	if host.resultBytes > 8*1024*1024 {
		t.Fatal("per-host result byte cap")
	}
	for i := 0; i < 21; i++ {
		r.cacheHistory(host, O{"type": "command_result", "requestId": "r", "status": "applied", "code": nil, "message": nil, "data": O{"kind": "session", "sessionId": fmt.Sprint(i)}}, "get")
	}
	if len(host.histories) != 20 || host.historyOrder[0] != "1" {
		t.Fatal("history FIFO")
	}
	r.releaseHost(host)
	if h.budget.size() != 0 || h.budget.cached != 0 {
		t.Fatal("cache quota leaked")
	}
}
func TestResultCloseTimeoutRaceCompletesAtMostOnce(t *testing.T) {
	for i := 0; i < 20; i++ {
		h, clock, c, cf, host, hf := setupCommands(t)
		send(t, h, c, command("r", "abort"))
		id := hf.drain()[0]["relayRequestId"].(string)
		raw, _ := protocol.EncodeWire(applied(id, nil))
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); _ = h.Handle(host, raw) }()
		go func() { defer wg.Done(); h.Leave(host) }()
		go func() { defer wg.Done(); clock.advance(15 * time.Second); h.Sync() }()
		wg.Wait()
		h.Sync()
		results := 0
		for _, v := range cf.drain() {
			if v["type"] == "command_result" {
				results++
			}
		}
		if results != 1 {
			t.Fatal("completion count", results)
		}
		h.Close()
	}
}
