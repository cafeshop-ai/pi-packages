package transport

import (
	"bytes"
	"context"
	"errors"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/httpserver"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/gorilla/websocket"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func dialTest(t *testing.T, opts Options, onMessage func(*Session, []byte), onDone chan *Session) (*websocket.Conn, func()) {
	t.Helper()
	origins, _ := auth.NewOrigins(nil)
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewServer(httpserver.NewHandler(nil, Handler(ctx, origins, opts, func(s *Session) { s.Run(ctx, onMessage); onDone <- s })))
	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = true
	conn, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatal(err)
	}
	if response.Header.Get("Sec-WebSocket-Extensions") != "" {
		t.Error("server enabled compression")
	}
	return conn, func() {
		conn.Close()
		cancel()
		select {
		case s := <-onDone:
			if s.PendingBytes() != 0 {
				t.Error("outbound quota not released")
			}
		case <-time.After(2 * time.Second):
			t.Error("session pumps leaked")
		}
		server.Close()
	}
}
func TestTextEchoBoundariesAndCleanup(t *testing.T) {
	for _, n := range []int{0, protocol.MaxFrameBytes} {
		t.Run(string(rune(n+65)), func(t *testing.T) {
			done := make(chan *Session, 1)
			c, cleanup := dialTest(t, Options{}, func(s *Session, b []byte) {
				s.MarkAuthenticated()
				if e := s.Send(b); e != nil {
					t.Error(e)
				}
			}, done)
			defer cleanup()
			data := bytes.Repeat([]byte("x"), n)
			if e := c.WriteMessage(websocket.TextMessage, data); e != nil {
				t.Fatal(e)
			}
			c.SetReadDeadline(time.Now().Add(time.Second))
			kind, b, e := c.ReadMessage()
			if e != nil || kind != websocket.TextMessage || !bytes.Equal(b, data) {
				t.Fatalf("echo %d: %v", n, e)
			}
		})
	}
}
func TestRejections(t *testing.T) {
	for _, tc := range []struct {
		name       string
		kind       int
		data       []byte
		code       int
		errorFrame bool
	}{
		{"binary", websocket.BinaryMessage, []byte("{}"), 1003, true},
		{"invalid-utf8", websocket.TextMessage, []byte{0xff}, 1007, false},
		{"oversize", websocket.TextMessage, bytes.Repeat([]byte("x"), protocol.MaxFrameBytes+1), 1009, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan *Session, 1)
			c, cleanup := dialTest(t, Options{}, func(*Session, []byte) { t.Error("rejected frame reached handler") }, done)
			defer cleanup()
			c.WriteMessage(tc.kind, tc.data)
			c.SetReadDeadline(time.Now().Add(2 * time.Second))
			if tc.errorFrame {
				_, b, e := c.ReadMessage()
				if e != nil || !bytes.Contains(b, []byte("BINARY_UNSUPPORTED")) {
					t.Fatalf("binary error %s %v", b, e)
				}
			}
			_, _, e := c.ReadMessage()
			var close *websocket.CloseError
			if !errors.As(e, &close) || close.Code != tc.code {
				t.Fatalf("close=%v want %d", e, tc.code)
			}
		})
	}
}
func TestFragmentedMessageLimit(t *testing.T) {
	done := make(chan *Session, 1)
	c, cleanup := dialTest(t, Options{}, func(*Session, []byte) { t.Error("oversize fragments reached handler") }, done)
	defer cleanup()
	w, e := c.NextWriter(websocket.TextMessage)
	if e != nil {
		t.Fatal(e)
	}
	chunk := bytes.Repeat([]byte("x"), 4096)
	for i := 0; i < 65; i++ {
		if _, e := w.Write(chunk); e != nil {
			break
		}
	}
	_ = w.Close()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, e = c.ReadMessage()
	var close *websocket.CloseError
	if !errors.As(e, &close) || close.Code != 1009 {
		t.Fatalf("fragment close: %v", e)
	}
}
func TestHelloDeadline(t *testing.T) {
	done := make(chan *Session, 1)
	c, cleanup := dialTest(t, Options{HelloTimeout: 30 * time.Millisecond}, func(*Session, []byte) {}, done)
	defer cleanup()
	c.SetReadDeadline(time.Now().Add(time.Second))
	_, _, e := c.ReadMessage()
	var close *websocket.CloseError
	if !errors.As(e, &close) || close.Code != 1008 {
		t.Fatalf("hello timeout close %v", e)
	}
}
func TestQueueLimitsAndCopies(t *testing.T) {
	s := newSession(nil, Options{}.defaults())
	payload := []byte("hello")
	if e := s.Send(payload); e != nil {
		t.Fatal(e)
	}
	payload[0] = 'X'
	if got := <-s.queue; string(got) != "hello" {
		t.Fatal("payload not copied")
	}
	s.release(5)
	for i := 0; i < 128; i++ {
		if e := s.Send([]byte("x")); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.Send([]byte("x")); e != ErrCapacity {
		t.Fatal(e)
	}
	if e := s.Send([]byte("x")); e != ErrClosed {
		t.Fatal(e)
	}
	s.discard()
	if s.PendingBytes() != 0 {
		t.Fatal("quota leaked")
	}
	b := newSession(nil, Options{}.defaults())
	for i := 0; i < 4; i++ {
		if e := b.Send(make([]byte, protocol.MaxFrameBytes)); e != nil {
			t.Fatal(e)
		}
	}
	if e := b.Send([]byte("x")); e != ErrCapacity {
		t.Fatal(e)
	}
	b.discard()
}
func TestHeartbeatPingDataAndClose(t *testing.T) {
	done := make(chan *Session, 1)
	ready := make(chan *Session, 1)
	c, cleanup := dialTest(t, Options{Heartbeat: 5 * time.Millisecond}, func(s *Session, _ []byte) { s.MarkAuthenticated(); ready <- s }, done)
	defer cleanup()
	c.WriteMessage(websocket.TextMessage, []byte("hello"))
	var s *Session
	select {
	case s = <-ready:
	case <-time.After(time.Second):
		t.Fatal("callback not reached")
	}
	ping := make(chan struct{}, 1)
	c.SetPingHandler(func(data string) error {
		select {
		case ping <- struct{}{}:
		default:
		}
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	readDone := make(chan struct{})
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	go func() {
		defer close(readDone)
		for {
			if _, _, e := c.ReadMessage(); e != nil {
				return
			}
		}
	}()
	select {
	case <-ping:
	case <-time.After(time.Second):
		c.Close()
		<-readDone
		t.Fatal("heartbeat not sent")
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			_ = c.WriteControl(websocket.PingMessage, []byte("client-ping"), time.Now().Add(time.Second))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			_ = s.Send([]byte("event"))
		}
		s.Close(1000, "done")
	}()
	wg.Wait()
	select {
	case <-readDone:
	case <-time.After(time.Second):
		c.Close()
		<-readDone
		t.Fatal("client read pump not released")
	}
}
func TestConcurrentSendAndClose(t *testing.T) {
	done := make(chan *Session, 1)
	c, cleanup := dialTest(t, Options{}, func(s *Session, b []byte) {
		s.MarkAuthenticated()
		for i := 0; i < 16; i++ {
			go func() { _ = s.Send([]byte("result")); s.Close(1000, "done") }()
		}
	}, done)
	defer cleanup()
	c.WriteMessage(websocket.TextMessage, []byte("hello"))
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
}
