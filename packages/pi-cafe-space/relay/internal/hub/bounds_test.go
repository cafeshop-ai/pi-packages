package hub

import (
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCompactionBudgetAndImmutableProjection(t *testing.T) {
	s := snapshot("s", "same", 0)
	messages := []any{}
	for i := 0; i < 101; i++ {
		messages = append(messages, O{"id": fmt.Sprint(i), "role": "assistant", "text": strings.Repeat("\x00", 8193), "thinking": "😀", "timestamp": float64(0), "status": "streaming", "toolName": nil, "toolCallId": nil})
	}
	s["messages"] = messages
	tools := []any{}
	for i := 0; i < 25; i++ {
		tools = append(tools, O{"toolCallId": fmt.Sprint(i), "toolName": "read", "argsText": strings.Repeat("x", 3000), "output": strings.Repeat("y", 5000), "status": "running"})
	}
	s["tools"] = tools
	before, _ := protocol.ValueBytes(s)
	compacted := compactSnapshot(s)
	after, _ := protocol.ValueBytes(s)
	if string(before) != string(after) {
		t.Fatal("input mutation")
	}
	b, e := protocol.EncodeWire(O{"type": "snapshot", "snapshot": compacted})
	if e != nil || len(b) > snapshotBudget || compacted["historyTruncated"] != true {
		t.Fatal("budget", len(b), e)
	}
	ms := compacted["messages"].([]any)
	if len(ms) == 0 || len(ms) > 100 || ms[len(ms)-1].(O)["id"] != "100" {
		t.Fatal("newest message lost")
	}
	for _, v := range ms {
		if protocol.UTF16Length(v.(O)["text"].(string)) > 8192 {
			t.Fatal("text limit")
		}
	}
	if got := truncate(strings.Repeat("a", 8178)+"😀"+strings.Repeat("b", 100), 8192); protocol.UTF16Length(got) > 8192 {
		t.Fatal("surrogate prefix limit")
	}
	phase := copyObject(compacted)
	phase["phase"] = "running"
	phase["lastEventSeq"] = float64(2)
	if historyRevision(phase) != historyRevision(compacted) {
		t.Fatal("state-only event changes history revision")
	}
	phase["cwd"] = "D:/test"
	if historyRevision(phase) == historyRevision(compacted) {
		t.Fatal("identity revision not changed")
	}
}
func TestRichStatusDropsMetadataNotHostIDs(t *testing.T) {
	h, _ := makeHub(t)
	r := newRoom(h, "test")
	for i := 0; i < 64; i++ {
		s := snapshot("s", "same", 0)
		s["cwd"] = strings.Repeat("中", 16384)
		id := fmt.Sprintf("host-%02d", i)
		r.hosts[id] = &host{id: id, snapshot: s, ready: true, connection: &Connection{}}
	}
	status := r.status()
	if size(status) > protocol.MaxFrameBytes {
		t.Fatal("oversize status")
	}
	for _, v := range status["hosts"].([]any) {
		o := v.(O)
		if o["cwd"] != nil || o["sessionId"] != nil || o["hostId"] == nil || o["ready"] != true {
			t.Fatal("metadata fallback", o)
		}
	}
}
func TestGlobalSnapshotQuotaRefusalAndRelease(t *testing.T) {
	h := New(Options{HostToken: "fixture-host", ClientToken: "fixture-client", StateBytes: 1300})
	defer h.Close()
	a, af := connect(t, h, "host", "a", "one")
	b, bf := connect(t, h, "host", "b", "two")
	send(t, h, a, O{"type": "snapshot", "snapshot": snapshot("s", "same", 0)})
	af.drain()
	s := snapshot("s", "same", 0)
	s["cwd"] = strings.Repeat("x", 600)
	send(t, h, b, O{"type": "snapshot", "snapshot": s})
	bf.mu.Lock()
	code := bf.code
	bf.mu.Unlock()
	if code != 1013 {
		t.Fatal("aggregate quota not enforced", code, h.Stats())
	}
	if h.Stats().Bytes > 1300 {
		t.Fatal("quota exceeded")
	}
	h.Leave(a)
	h.Leave(b)
	h.Sync()
	h.Close()
	if h.Stats().Bytes != 0 {
		t.Fatal("quota leaked")
	}
}
func TestHostAndRoomAdmissionBoundaries(t *testing.T) {
	h, _ := makeHub(t)
	hosts := []*Connection{}
	for i := 0; i < 64; i++ {
		c, _ := connect(t, h, "host", fmt.Sprint(i), "main")
		hosts = append(hosts, c)
	}
	rejected, rf := connect(t, h, "host", "overflow", "main")
	rf.mu.Lock()
	code := rf.code
	rf.mu.Unlock()
	if code != 1008 {
		t.Fatal("host limit")
	}
	h.Leave(rejected)
	h.Leave(hosts[0])
	h.Sync()
	replacement, f := connect(t, h, "host", "new", "main")
	if !replacement.Authenticated() {
		t.Fatal("offline capacity not evicted", f.drain())
	}
	for i := 0; i < 255; i++ {
		connect(t, h, "client", "c", fmt.Sprintf("room-%d", i))
	}
	_, f = connect(t, h, "client", "c", "overflow-room")
	messages := f.drain()
	if len(messages) != 1 || messages[0]["code"] != "ROOM_LIMIT" {
		t.Fatal("room admission", messages)
	}
	h.Close()
	if s := h.Stats(); s.Bytes != 0 || s.Rooms != 0 || s.Connections != 0 {
		t.Fatal(s)
	}
}
func TestRetireEmptyRoomsAndConcurrentLifecycle(t *testing.T) {
	h, _ := makeHub(t)
	for i := 0; i < 50; i++ {
		c, _ := connect(t, h, "client", "c", "ephemeral")
		h.Leave(c)
		h.Sync()
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				f := &fakeSender{}
				c, e := h.Join(f, fmt.Sprint(i))
				if e != nil {
					t.Error(e)
					return
				}
				hello := O{"type": "hello", "protocolVersion": float64(1), "peerRole": "client", "peerId": fmt.Sprint(i), "roomId": "concurrent", "token": "fixture-client"}
				b, _ := protocol.EncodeWire(hello)
				if e = h.Handle(c, b); e != nil {
					t.Error(e)
				}
				h.Leave(c)
				h.Leave(c)
			}
		}(i)
	}
	wg.Wait()
	h.Sync()
	h.Close()
	if s := h.Stats(); s.Bytes != 0 || s.Rooms != 0 || s.Connections != 0 {
		t.Fatal(s)
	}
}
func TestEventWrongContextAndReconnectSnapshotFence(t *testing.T) {
	h, _ := makeHub(t)
	a, _ := connect(t, h, "host", "a", "main")
	send(t, h, a, O{"type": "snapshot", "snapshot": snapshot("s", "session", 10)})
	h.Leave(a)
	h.Sync()
	next, f := connect(t, h, "host", "a", "main")
	f.drain()
	send(t, h, next, O{"type": "snapshot", "snapshot": snapshot("s", "session", 9)})
	if got := f.drain(); len(got) != 1 || got[0]["code"] != "STALE_SNAPSHOT" {
		t.Fatal(got)
	}
	h.Leave(next)
	h.Sync()
	third, f := connect(t, h, "host", "a", "main")
	f.drain()
	send(t, h, third, O{"type": "snapshot", "snapshot": snapshot("new", "session", 0)})
	send(t, h, third, O{"type": "event", "streamId": "old", "sessionId": "session", "seq": float64(1), "emittedAt": "now", "event": O{"kind": "notice", "level": "info", "message": "x"}})
	if got := f.drain(); len(got) != 1 || got[0]["message"] != "Event does not belong to this snapshot" {
		t.Fatal(got)
	}
}
func TestGlobalPressureReclaimsOtherOfflineRoom(t *testing.T) {
	h, _ := makeHub(t)
	c, _ := connect(t, h, "host", "offline", "first")
	send(t, h, c, O{"type": "snapshot", "snapshot": snapshot("s", "session", 0)})
	h.Leave(c)
	h.Sync()
	if h.Stats().Bytes == 0 {
		t.Fatal("no retained projection")
	}
	if h.ReserveQueue(MaxStateBytes) {
		t.Fatal("over-budget queue admitted")
	}
	h.Sync()
	if h.Stats().Bytes != 0 {
		t.Fatal("other room did not reclaim offline projection", h.Stats())
	}
}
func TestClosedAdmission(t *testing.T) {
	h, _ := makeHub(t)
	h.Close()
	if _, e := h.Join(&fakeSender{}, "test"); e != ErrClosed {
		t.Fatal(e)
	}
	done := make(chan struct{})
	go func() { h.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("repeat Close blocked")
	}
}
