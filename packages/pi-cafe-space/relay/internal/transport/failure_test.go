package transport

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

type blockedConnection struct {
	closed            chan struct{}
	writing           chan struct{}
	once, writingOnce sync.Once
	deadline          time.Time // only writer pump sets/reads this field
}

func (c *blockedConnection) NextReader() (int, io.Reader, error)     { <-c.closed; return 0, nil, io.EOF }
func (c *blockedConnection) SetReadLimit(int64)                      {}
func (c *blockedConnection) SetReadDeadline(time.Time) error         { return nil }
func (c *blockedConnection) SetWriteDeadline(t time.Time) error      { c.deadline = t; return nil }
func (c *blockedConnection) SetPongHandler(func(string) error)       {}
func (c *blockedConnection) SetPingHandler(func(string) error)       {}
func (c *blockedConnection) SetCloseHandler(func(int, string) error) {}
func (c *blockedConnection) WriteMessage(int, []byte) error {
	c.writingOnce.Do(func() { close(c.writing) })
	timer := time.NewTimer(time.Until(c.deadline))
	defer timer.Stop()
	select {
	case <-timer.C:
		return context.DeadlineExceeded
	case <-c.closed:
		return io.ErrClosedPipe
	}
}
func (c *blockedConnection) WriteControl(int, []byte, time.Time) error { return nil }
func (c *blockedConnection) Close() error                              { c.once.Do(func() { close(c.closed) }); return nil }
func TestBlockedWriterDeadlineAndForcedClose(t *testing.T) {
	for _, mode := range []string{"deadline", "close", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c := &blockedConnection{closed: make(chan struct{}), writing: make(chan struct{})}
			opts := Options{WriteTimeout: 30 * time.Millisecond, CloseGrace: 20 * time.Millisecond}.defaults()
			if mode != "deadline" {
				opts.WriteTimeout = 5 * time.Second
			}
			s := newSession(c, opts)
			if e := s.Send([]byte("frame")); e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() { defer close(done); s.Run(ctx, func(*Session, []byte) {}) }()
			select {
			case <-c.writing:
			case <-time.After(time.Second):
				t.Fatal("writer did not start")
			}
			switch mode {
			case "close":
				s.Close(1000, "done")
				s.Close(1000, "done")
			case "cancel":
				cancel()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				_ = c.Close()
				t.Fatal("pumps leaked on blocked writer")
			}
			if s.PendingBytes() != 0 {
				t.Fatal("in-flight quota leaked")
			}
			if e := s.Send([]byte("late")); e != ErrClosed {
				t.Fatal("accepted after close")
			}
		})
	}
}
