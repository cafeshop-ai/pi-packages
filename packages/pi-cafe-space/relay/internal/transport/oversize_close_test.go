package transport

import (
	"context"
	"github.com/gorilla/websocket"
	"io"
	"testing"
	"time"
)

type oversizedConnection struct {
	blockedConnection
	control chan []byte
}

func (c *oversizedConnection) NextReader() (int, io.Reader, error) {
	return 0, nil, websocket.ErrReadLimit
}
func (c *oversizedConnection) WriteControl(kind int, body []byte, deadline time.Time) error {
	if kind == websocket.CloseMessage {
		c.control <- append([]byte(nil), body...)
	}
	return nil
}
func TestOversizedFrameCloseUsesExistingGrace(t *testing.T) {
	c := &oversizedConnection{blockedConnection: blockedConnection{closed: make(chan struct{}), writing: make(chan struct{})}, control: make(chan []byte, 1)}
	grace := 40 * time.Millisecond
	s := newSession(c, Options{CloseGrace: grace}.defaults())
	done := make(chan struct{})
	start := time.Now()
	go func() {
		defer close(done)
		s.Run(context.Background(), func(*Session, []byte) { t.Error("rejected body reached application") })
	}()
	select {
	case frame := <-c.control:
		if len(frame) < 2 || int(frame[0])*256+int(frame[1]) != 1009 {
			t.Fatal("missing 1009 close")
		}
	case <-time.After(time.Second):
		t.Fatal("close control missing")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		_ = c.Close()
		t.Fatal("close grace did not bound cleanup")
	}
	if time.Since(start) < grace/2 {
		t.Fatal("immediate TCP close can reset unread oversized body before control delivery")
	}
	if s.PendingBytes() != 0 {
		t.Fatal("queue quota leaked")
	}
}
