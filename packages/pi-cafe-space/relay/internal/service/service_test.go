package service

import (
	"context"
	"errors"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/gorilla/websocket"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func start(t *testing.T) (*Service, string, chan error) {
	t.Helper()
	s, e := New(config.Config{HostToken: "fixture-host", ClientToken: "fixture-client"}, Options{})
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- s.Serve(l) }()
	return s, "ws://" + l.Addr().String() + "/ws", done
}
func finish(t *testing.T, s *Service, done chan error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e := s.Close(ctx); e != nil {
		t.Error(e)
	}
	if e := <-done; !errors.Is(e, http.ErrServerClosed) {
		t.Error(e)
	}
	if got := s.Hub.Stats(); got != (hub.Stats{}) {
		t.Error("remaining state", got)
	}
}
func TestShutdownClosesHijackedSessionsAndAdmission(t *testing.T) {
	s, url, done := start(t)
	defer finish(t, s, done)
	cs := []*websocket.Conn{}
	for i := 0; i < 8; i++ {
		c, _, e := websocket.DefaultDialer.Dial(url, nil)
		if e != nil {
			t.Fatal(e)
		}
		cs = append(cs, c)
		defer c.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e := s.Close(ctx); e != nil {
		t.Fatal(e)
	}
	for _, c := range cs {
		c.SetReadDeadline(time.Now().Add(time.Second))
		_, _, e := c.ReadMessage()
		var close *websocket.CloseError
		if !errors.As(e, &close) || close.Code != 1001 {
			t.Fatal("shutdown close", e)
		}
	}
	if got := s.Hub.Stats(); got != (hub.Stats{}) {
		t.Fatal(got)
	}
}
func TestPreUpgradeAdmissionAndOrigin(t *testing.T) {
	s, url, done := start(t)
	defer finish(t, s, done)
	bad := http.Header{"Origin": []string{"https://evil.invalid"}}
	c, response, e := websocket.DefaultDialer.Dial(url, bad)
	if c != nil {
		c.Close()
	}
	if e == nil || response.StatusCode != 403 {
		t.Fatal("Origin gate", e, response)
	}
	response.Body.Close()
	for _, path := range []string{"/ws/", "/%77s", "/WS"} {
		_, response, e := websocket.DefaultDialer.Dial(strings.TrimSuffix(url, "/ws")+path, nil)
		if e == nil || response.StatusCode != 404 {
			t.Fatal("exact upgrade path", path, e)
		}
		response.Body.Close()
	}
	cs := []*websocket.Conn{}
	for i := 0; i < 32; i++ {
		c, _, e := websocket.DefaultDialer.Dial(url, nil)
		if e != nil {
			t.Fatal(e)
		}
		cs = append(cs, c)
	}
	_, response, e = websocket.DefaultDialer.Dial(url, nil)
	if e == nil || response.StatusCode != 503 {
		t.Fatal("preupgrade handshake cap", e)
	}
	response.Body.Close()
	for _, c := range cs {
		c.Close()
	}
}
func TestRejectedUpgradeDoesNotLeakQuota(t *testing.T) {
	s, url, done := start(t)
	defer finish(t, s, done)
	endpoint := "http" + strings.TrimPrefix(url, "ws")
	for i := 0; i < 40; i++ {
		response, e := http.Get(endpoint)
		if e != nil {
			t.Fatal(e)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatal(response.StatusCode)
		}
	}
	if s.Hub.Stats().Connections != 0 {
		t.Fatal("failed upgrade reservation leaked", s.Hub.Stats())
	}
}
