package service

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/transport"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

type timerEntry struct {
	id       int
	due      time.Time
	callback func()
}
type manualClock struct {
	mu     sync.Mutex
	now    time.Time
	next   int
	timers map[int]timerEntry
}

func (c *manualClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *manualClock) AfterFunc(d time.Duration, f func()) func() {
	c.mu.Lock()
	c.next++
	id := c.next
	c.timers[id] = timerEntry{id, c.now.Add(d), f}
	c.mu.Unlock()
	return func() { c.mu.Lock(); delete(c.timers, id); c.mu.Unlock() }
}
func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	due := []func(){}
	for id, t := range c.timers {
		if !c.now.Before(t.due) {
			due = append(due, t.callback)
			delete(c.timers, id)
		}
	}
	c.mu.Unlock()
	for _, f := range due {
		f()
	}
}

// TestTraceBridge is only enabled by the isolated TS test harness. Its command
// channel is process stdin/stdout, never an HTTP admin endpoint. It owns only a
// newly allocated loopback listener; no model/Pi/browser/service is contacted.
func TestTraceBridge(t *testing.T) {
	if os.Getenv("PI_CAFE_TRACE_BRIDGE") != "1" {
		return
	}
	clock := &manualClock{now: time.Unix(0, 0), timers: map[int]timerEntry{}}
	s, e := New(config.Config{HostToken: "fixture-host", ClientToken: "fixture-client"}, Options{Hub: hub.Options{Now: clock.Now}, Transport: transport.Options{AfterFunc: clock.AfterFunc}})
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- s.Serve(listener) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e := s.Close(ctx); e != nil {
			t.Error(e)
		}
		<-serveDone
		if got := s.Hub.Stats(); got != (hub.Stats{}) {
			t.Error("quota not released", got)
		}
	}()
	fmt.Println("TRACE " + `{"url":"ws://` + listener.Addr().String() + `/ws"}`)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), 4096)
	for scanner.Scan() {
		var request struct {
			Action string
			MS     int
		}
		if e := json.Unmarshal(scanner.Bytes(), &request); e != nil {
			t.Fatal(e)
		}
		switch request.Action {
		case "advance":
			clock.Advance(time.Duration(request.MS) * time.Millisecond)
			s.Hub.Sync()
			fmt.Println(`TRACE {"advanced":true}`)
		case "sync":
			s.Hub.Sync()
			fmt.Println(`TRACE {"synced":true}`)
		case "close":
			return
		default:
			t.Fatal("invalid bridge action")
		}
	}
	if e := scanner.Err(); e != nil {
		t.Fatal(e)
	}
}
