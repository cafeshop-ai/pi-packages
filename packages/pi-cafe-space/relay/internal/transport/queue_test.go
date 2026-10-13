package transport

import (
	"context"
	"github.com/gorilla/websocket"
	"sync"
	"testing"
	"time"
)

type recordingConnection struct {
	blockedConnection
	mu       sync.Mutex
	frames   []int
	payloads []string
}

func (c *recordingConnection) WriteMessage(kind int, b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, kind)
	c.payloads = append(c.payloads, string(b))
	return nil
}
func (c *recordingConnection) WriteControl(kind int, b []byte, _ time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, kind)
	c.payloads = append(c.payloads, string(b))
	return nil
}
func TestAdmittedErrorPrecedesCloseAndReleasesGlobalBudget(t *testing.T) {
	c := &recordingConnection{blockedConnection: blockedConnection{closed: make(chan struct{}), writing: make(chan struct{})}}
	var mu sync.Mutex
	bytes := 0
	options := Options{ReserveBytes: func(n int) bool {
		mu.Lock()
		defer mu.Unlock()
		if bytes+n > 8 {
			return false
		}
		bytes += n
		return true
	}, ReleaseBytes: func(n int) { mu.Lock(); defer mu.Unlock(); bytes -= n }}.defaults()
	s := newSession(c, options)
	if e := s.Send([]byte("error")); e != nil {
		t.Fatal(e)
	}
	s.Close(1008, "rejected")
	s.Run(context.Background(), func(*Session, []byte) {})
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) != 2 || c.frames[0] != websocket.TextMessage || c.payloads[0] != "error" || c.frames[1] != websocket.CloseMessage {
		t.Fatal("protocol error lost before close", c.frames, c.payloads)
	}
	mu.Lock()
	defer mu.Unlock()
	if bytes != 0 || s.PendingBytes() != 0 {
		t.Fatal("quota not released", bytes)
	}
}
func TestGlobalBudgetRejectsBeforeCopying(t *testing.T) {
	s := newSession(nil, Options{ReserveBytes: func(int) bool { return false }}.defaults())
	if e := s.Send([]byte("x")); e != ErrCapacity {
		t.Fatal(e)
	}
	if s.PendingBytes() != 0 || len(s.queue) != 0 {
		t.Fatal("failed reservation retained data")
	}
}
