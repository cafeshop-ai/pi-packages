package hub

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"sync"
	"testing"
	"time"
)

type O = protocol.Object
type fakeSender struct {
	mu       sync.Mutex
	messages []O
	closed   bool
	code     int
	reason   string
}

func (f *fakeSender) Send(b []byte) error {
	v, e := protocol.DecodeWire(b)
	if e != nil {
		return e
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages = append(f.messages, v)
	return nil
}
func (f *fakeSender) Close(code int, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.code = code
	f.reason = reason
}
func (f *fakeSender) drain() []O {
	f.mu.Lock()
	defer f.mu.Unlock()
	v := f.messages
	f.messages = nil
	return v
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }
func makeHub(t *testing.T) (*Hub, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.Unix(0, 0)}
	h := New(Options{HostToken: "fixture-host", ClientToken: "fixture-client", Now: clock.Now})
	t.Cleanup(h.Close)
	return h, clock
}
func connect(t *testing.T, h *Hub, role, peer, room string) (*Connection, *fakeSender) {
	t.Helper()
	f := &fakeSender{}
	c, e := h.Join(f, "127.0.0.1")
	if e != nil {
		t.Fatal(e)
	}
	send(t, h, c, O{"type": "hello", "protocolVersion": float64(1), "peerRole": role, "peerId": peer, "roomId": room, "token": "fixture-" + role})
	return c, f
}
func send(t *testing.T, h *Hub, c *Connection, o O) {
	t.Helper()
	b, e := protocol.EncodeWire(o)
	if e != nil {
		t.Fatal(e)
	}
	if e = h.Handle(c, b); e != nil {
		t.Fatal(e)
	}
}
func snapshot(stream, session string, seq float64) O {
	return O{"protocolVersion": float64(1), "streamId": stream, "sessionId": session, "sessionName": nil, "cwd": "C:/test", "activeLeafId": nil, "model": nil, "thinkingLevel": "off", "phase": "idle", "hasPendingMessages": false, "messages": []any{}, "tools": []any{}, "historyTruncated": false, "lastEventSeq": seq}
}
func TestRoomsHostsReplacementAndSequence(t *testing.T) {
	h, _ := makeHub(t)
	c, cf := connect(t, h, "client", "browser", "room")
	_, other := connect(t, h, "client", "browser", "other")
	cf.drain()
	other.drain()
	a, af := connect(t, h, "host", "a", "room")
	b, _ := connect(t, h, "host", "b", "room")
	send(t, h, a, O{"type": "snapshot", "snapshot": snapshot("s", "same", 2)})
	send(t, h, b, O{"type": "snapshot", "snapshot": snapshot("s", "same", 4)})
	if len(other.drain()) != 0 {
		t.Fatal("cross-room broadcast")
	}
	cf.drain()
	replacement, _ := connect(t, h, "host", "a", "room")
	states := cf.drain()
	last := states[len(states)-1]["hosts"].([]any)
	if last[0].(O)["hostId"] != "b" || last[1].(O)["ready"] != false {
		t.Fatal("replacement readiness/sort", last)
	}
	if !af.closed || af.reason != "Replaced by host reconnect" {
		t.Fatal("old host not replaced")
	}
	h.Leave(a)
	h.Sync()
	if len(cf.drain()) != 0 {
		t.Fatal("old close changed new generation")
	}
	send(t, h, replacement, O{"type": "snapshot", "snapshot": snapshot("s", "same", 3)})
	cf.drain()
	send(t, h, replacement, O{"type": "event", "streamId": "s", "sessionId": "same", "seq": float64(3), "emittedAt": "now", "event": O{"kind": "notice", "message": "duplicate", "level": "info"}})
	got := cf.drain()
	if len(got) != 1 || got[0]["type"] != "host_status" {
		t.Fatal("divergence must gate readiness", got)
	}
	h.Leave(c)
	h.Leave(replacement)
	h.Leave(b)
	h.Sync()
}
func TestSnapshotDeadlineOfflineExpiryAndQuota(t *testing.T) {
	h, clock := makeHub(t)
	_, cf := connect(t, h, "client", "browser", "main")
	a, af := connect(t, h, "host", "a", "main")
	cf.drain()
	clock.advance(5 * time.Second)
	h.Sync()
	if !af.closed || af.code != 1008 || af.reason != "Snapshot required" {
		t.Fatal("snapshot timeout")
	}
	h.Leave(a)
	h.Sync()
	cf.drain()
	clock.advance(30 * time.Minute)
	h.Sync()
	got := cf.drain()
	if len(got) != 1 || len(got[0]["hosts"].([]any)) != 0 {
		t.Fatal("offline expiry", got)
	}
	h.Close()
	if s := h.Stats(); s.Connections != 0 || s.Rooms != 0 || s.Bytes != 0 {
		t.Fatal("shutdown quota leak", s)
	}
}
func TestAdmissionReleasedAndBounded(t *testing.T) {
	h, _ := makeHub(t)
	cs := []*Connection{}
	for i := 0; i < 32; i++ {
		c, e := h.Join(&fakeSender{}, "one")
		if e != nil {
			t.Fatal(e)
		}
		cs = append(cs, c)
	}
	if _, e := h.Join(&fakeSender{}, "one"); e != ErrCapacity {
		t.Fatal("per-address handshake limit", e)
	}
	h.Leave(cs[0])
	h.Leave(cs[0])
	if _, e := h.Join(&fakeSender{}, "one"); e != nil {
		t.Fatal("quota not released", e)
	}
	h.Close()
	if h.Stats().Connections != 0 {
		t.Fatal("leaked admission")
	}
}
