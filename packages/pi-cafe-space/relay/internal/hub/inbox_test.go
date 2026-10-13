package hub

import (
	"sync"
	"testing"
	"time"
)

// A test-only stalled sender holds the actor at a known point while admissions
// race with shutdown. Production Sender is a nonblocking bounded queue.
type gatedSender struct {
	fakeSender
	entered, release chan struct{}
	once             sync.Once
}

func (s *gatedSender) Send(b []byte) error {
	s.once.Do(func() { close(s.entered); <-s.release })
	return s.fakeSender.Send(b)
}
func TestInboxCountBytesAndCloseControl(t *testing.T) {
	for _, mode := range []string{"count", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			h, _ := makeHub(t)
			r := newRoom(h, "test")
			r.refs = 1
			h.mu.Lock()
			h.rooms[r.id] = r
			h.wg.Add(1)
			h.mu.Unlock()
			go r.run()
			f := &gatedSender{entered: make(chan struct{}), release: make(chan struct{})}
			c := &Connection{hub: h, sender: f, role: "client", peer: "c", id: "id", room: r}
			var wg sync.WaitGroup
			wg.Add(1)
			go func() { defer wg.Done(); _ = r.call(c, O{}, 1, true) }()
			select {
			case <-f.entered:
			case <-time.After(time.Second):
				close(f.release)
				t.Fatal("actor not entered")
			}
			count, n := 127, 1
			if mode == "bytes" {
				count, n = 4, 256*1024-1
			}
			for i := 0; i < count; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); _ = r.call(c, O{"type": "snapshot"}, n, false) }()
			}
			deadline := time.Now().Add(time.Second)
			for {
				r.inboxMu.Lock()
				admitted := r.inboxCount
				r.inboxMu.Unlock()
				if admitted == count+1 {
					break
				}
				if time.Now().After(deadline) {
					close(f.release)
					wg.Wait()
					t.Fatal("admissions did not finish", admitted)
				}
				time.Sleep(time.Millisecond)
			}
			overflow := 1
			if mode == "bytes" {
				overflow = 4
			}
			if e := r.call(c, O{}, overflow, false); e != ErrCapacity {
				close(f.release)
				wg.Wait()
				t.Fatal("overflow admitted", e)
			}
			c.departed.Store(true)
			r.wakeUp()
			r.stopOnce.Do(func() { close(r.stop) })
			close(f.release)
			wg.Wait()
			select {
			case <-r.done:
			case <-time.After(time.Second):
				t.Fatal("control trapped behind saturated data")
			}
			if h.budget.size() != 0 {
				t.Fatal("failed/queued admissions leaked bytes", h.budget.size())
			}
		})
	}
}
