// Package transport owns one WebSocket reader/writer and a bounded immutable
// send queue. It does not own rooms, commands, models or tools.
package transport

import (
	"bytes"
	"context"
	"errors"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/gorilla/websocket"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const MaxQueueCount = 128
const MaxQueueBytes = 1024 * 1024

var ErrClosed = errors.New("connection is closing")
var ErrCapacity = errors.New("connection send queue is full")
var ErrFrameTooLarge = errors.New("outbound frame exceeds limit")

type Options struct {
	HelloTimeout, Heartbeat, ReadTimeout, WriteTimeout, CloseGrace time.Duration
	// Pure application-clock seam; network I/O deadlines always use real time.
	AfterFunc    func(time.Duration, func()) func()
	ReserveBytes func(int) bool
	ReleaseBytes func(int)
}

func (o Options) defaults() Options {
	if o.HelloTimeout <= 0 {
		o.HelloTimeout = 5 * time.Second
	}
	if o.Heartbeat <= 0 {
		o.Heartbeat = 30 * time.Second
	}
	if o.ReadTimeout <= 0 {
		o.ReadTimeout = 60 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 5 * time.Second
	}
	if o.CloseGrace <= 0 {
		o.CloseGrace = time.Second
	}
	if o.AfterFunc == nil {
		o.AfterFunc = func(d time.Duration, f func()) func() { t := time.AfterFunc(d, f); return func() { t.Stop() } }
	}
	return o
}

// A narrow seam permits deterministic blocked-writer/failure tests. Production
// always supplies a Gorilla connection; no fake transport is selected at runtime.
type connection interface {
	NextReader() (int, io.Reader, error)
	SetReadLimit(int64)
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
	SetPongHandler(func(string) error)
	SetPingHandler(func(string) error)
	SetCloseHandler(func(int, string) error)
	WriteMessage(int, []byte) error
	WriteControl(int, []byte, time.Time) error
	Close() error
}
type Session struct {
	conn          connection
	options       Options
	queue         chan []byte
	stop          chan struct{}
	writerDone    chan struct{}
	mu            sync.Mutex
	closing       bool
	pendingBytes  int
	pendingCount  int
	closeCode     int
	closeReason   string
	finalFrame    []byte
	authenticated atomic.Bool
	runOnce       sync.Once
}

func newSession(conn connection, options Options) *Session {
	return &Session{conn: conn, options: options, queue: make(chan []byte, MaxQueueCount), stop: make(chan struct{}), writerDone: make(chan struct{})}
}
func Handler(ctx context.Context, origins auth.Origins, options Options, serve func(*Session)) http.Handler {
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, HandshakeTimeout: 5 * time.Second, EnableCompression: false, CheckOrigin: origins.Allowed}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.EscapedPath() != "/ws" {
			http.NotFound(w, r)
			return
		}
		select {
		case <-ctx.Done():
			http.Error(w, "Relay is shutting down", 503)
			return
		default:
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// A handler is responsible for synchronously calling Run, which joins its
		// pumps before returning. Never let a failed callback leave an open socket.
		defer conn.Close()
		serve(newSession(conn, options.defaults()))
	})
}
func (s *Session) PendingBytes() int { s.mu.Lock(); defer s.mu.Unlock(); return s.pendingBytes }
func (s *Session) Send(payload []byte) error {
	if len(payload) > protocol.MaxFrameBytes {
		return ErrFrameTooLarge
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return ErrClosed
	}
	if s.pendingCount >= MaxQueueCount || s.pendingBytes+len(payload) > MaxQueueBytes {
		s.mu.Unlock()
		s.Close(1013, "Client is too slow")
		return ErrCapacity
	}
	if s.options.ReserveBytes != nil && !s.options.ReserveBytes(len(payload)) {
		s.mu.Unlock()
		s.Close(1013, "Relay state budget exceeded")
		return ErrCapacity
	}
	copy := append([]byte{}, payload...)
	s.pendingBytes += len(copy)
	s.pendingCount++
	s.queue <- copy
	s.mu.Unlock()
	return nil
}
func (s *Session) release(n int) {
	s.mu.Lock()
	s.pendingBytes -= n
	s.pendingCount--
	s.mu.Unlock()
	if s.options.ReleaseBytes != nil {
		s.options.ReleaseBytes(n)
	}
}
func (s *Session) discard() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		select {
		case <-s.queue:
		default:
			if s.options.ReleaseBytes != nil {
				s.options.ReleaseBytes(s.pendingBytes)
			}
			s.pendingBytes = 0
			s.pendingCount = 0
			return
		}
	}
}
func (s *Session) Close(code int, reason string) { s.closeWithFrame(code, reason, nil) }
func (s *Session) closeWithFrame(code int, reason string, frame []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	s.closing = true
	// Only fixed transport reasons should be supplied; keep user callbacks from
	// making an illegal/oversized close control frame.
	if len(reason) > 120 {
		reason = "Connection closed"
	}
	if !utf8.ValidString(reason) {
		reason = "Connection closed"
	}
	if code == 1005 {
		code = 1000
	}
	s.closeCode = code
	s.closeReason = reason
	s.finalFrame = frame
	close(s.stop)
}
func (s *Session) MarkAuthenticated() {
	if s.authenticated.CompareAndSwap(false, true) {
		_ = s.conn.SetReadDeadline(time.Now().Add(s.options.ReadTimeout))
	}
}
func (s *Session) Run(ctx context.Context, onMessage func(*Session, []byte)) {
	s.runOnce.Do(func() { s.run(ctx, onMessage) })
}
func (s *Session) run(ctx context.Context, onMessage func(*Session, []byte)) {
	s.conn.SetReadLimit(protocol.MaxFrameBytes)
	_ = s.conn.SetReadDeadline(time.Now().Add(s.options.HelloTimeout))
	s.conn.SetPongHandler(func(string) error {
		if s.authenticated.Load() {
			return s.conn.SetReadDeadline(time.Now().Add(s.options.ReadTimeout))
		}
		return nil
	})
	s.conn.SetPingHandler(func(data string) error {
		return s.conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(s.options.CloseGrace))
	})
	s.conn.SetCloseHandler(func(code int, text string) error { s.Close(code, text); return nil })
	stopHello := s.options.AfterFunc(s.options.HelloTimeout, func() {
		if !s.authenticated.Load() {
			s.Close(1008, "Handshake timeout")
		}
	})
	defer stopHello()
	go s.writePump()
	watchdogDone := make(chan struct{})
	go func() {
		defer close(watchdogDone)
		select {
		case <-ctx.Done():
			s.Close(1001, "Server shutting down")
		case <-s.stop:
		}
		timer := time.NewTimer(s.options.CloseGrace)
		defer timer.Stop()
		select {
		case <-s.writerDone:
		case <-timer.C:
			_ = s.conn.Close()
		}
	}()
	defer func() {
		if recover() != nil {
			s.Close(1011, "Internal relay error")
		} else {
			s.Close(1000, "Connection closed")
		}
		<-s.writerDone
		_ = s.conn.Close()
		<-watchdogDone
	}()
	for {
		kind, reader, err := s.conn.NextReader()
		if err != nil {
			var timeout net.Error
			if errors.Is(err, websocket.ErrReadLimit) {
				s.Close(1009, "Message is too large")
			} else if errors.As(err, &timeout) && timeout.Timeout() && !s.authenticated.Load() {
				s.Close(1008, "Handshake timeout")
			} else {
				s.Close(1000, "Connection closed")
			}
			return
		}
		if kind != websocket.TextMessage {
			s.closeWithFrame(1003, "Binary frames are not supported", []byte(`{"type":"error","code":"BINARY_UNSUPPORTED","message":"Only JSON text frames are supported"}`))
			return
		}
		payload, err := io.ReadAll(io.LimitReader(reader, protocol.MaxFrameBytes+1))
		if err != nil || len(payload) > protocol.MaxFrameBytes {
			if errors.Is(err, websocket.ErrReadLimit) || len(payload) > protocol.MaxFrameBytes {
				s.Close(1009, "Message is too large")
			} else {
				s.Close(1008, "Invalid relay message")
			}
			return
		}
		if !utf8.Valid(payload) {
			s.Close(1007, "")
			return
		}
		payload = bytes.TrimPrefix(payload, []byte{0xef, 0xbb, 0xbf})
		onMessage(s, payload)
		select {
		case <-s.stop:
			return
		default:
		}
	}
}
func (s *Session) writePump() {
	defer close(s.writerDone)
	defer s.discard()
	defer s.conn.Close()
	ticker := time.NewTicker(s.options.Heartbeat)
	defer ticker.Stop()
	defer func() {
		if recover() != nil {
			s.Close(1011, "Internal relay error")
		}
	}()
	ping := func() bool {
		if err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(s.options.CloseGrace)); err != nil {
			s.Close(1011, "Heartbeat failed")
			return false
		}
		return true
	}
	closing := func() {
		s.mu.Lock()
		code, reason, frame := s.closeCode, s.closeReason, s.finalFrame
		s.mu.Unlock()
		deadline := time.Now().Add(s.options.CloseGrace)
		// Preserve already-admitted protocol errors/results before close, as
		// Node ws.send(...); ws.close(...) does. Overload skips this best effort.
		if code != 1013 {
		drain:
			for {
				select {
				case payload := <-s.queue:
					_ = s.conn.SetWriteDeadline(deadline)
					err := s.conn.WriteMessage(websocket.TextMessage, payload)
					s.release(len(payload))
					if err != nil || !time.Now().Before(deadline) {
						break drain
					}
				default:
					break drain
				}
			}
		}
		if len(frame) > 0 {
			_ = s.conn.SetWriteDeadline(deadline)
			_ = s.conn.WriteMessage(websocket.TextMessage, frame)
		}
		_ = s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), deadline)
		if code == 1009 {
			// Gorilla rejects an oversized frame from its header without consuming
			// the body. An immediate TCP close with unread bytes can reset the
			// connection before a Node/browser peer sees the 1009 control frame.
			// Allow delivery within the EXISTING close grace; the watchdog still
			// enforces its original deadline. Never read/allocate the rejected body.
			timer := time.NewTimer(time.Until(deadline))
			<-timer.C
			timer.Stop()
		}
	}
	for {
		// Do not let an always-ready data queue starve close/control.
		select {
		case <-s.stop:
			closing()
			return
		default:
		}
		select {
		case <-ticker.C:
			if !ping() {
				return
			}
			continue
		default:
		}
		select {
		case <-s.stop:
			closing()
			return
		case payload := <-s.queue:
			_ = s.conn.SetWriteDeadline(time.Now().Add(s.options.WriteTimeout))
			err := s.conn.WriteMessage(websocket.TextMessage, payload)
			s.release(len(payload))
			if err != nil {
				s.Close(1011, "Unable to send message")
				return
			}
		case <-ticker.C:
			if !ping() {
				return
			}
		}
	}
}
