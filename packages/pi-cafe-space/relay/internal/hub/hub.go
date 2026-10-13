// Package hub owns bounded in-memory collaboration state. Each room has one
// writer. Registry locks never surround room waits or sender calls.
package hub

import (
	"crypto/rand"
	"errors"
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

type object = protocol.Object

const MaxConnections = 512
const MaxRooms = 256
const MaxHosts = 64
const MaxClients = 256
const MaxInboxCount = 128
const MaxInboxBytes = 1024 * 1024
const MaxStateBytes = 128 * 1024 * 1024

var ErrClosed = errors.New("hub is closed")
var ErrCapacity = errors.New("hub capacity exceeded")
var roomID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// Sender only admits immutable bytes to a bounded transport queue. Send/Close
// must not perform blocking network I/O; room loops never write sockets.
type Sender interface {
	Send([]byte) error
	Close(int, string)
}
type Options struct {
	HostToken, ClientToken string
	Now                    func() time.Time
	ID                     func() string
	OfflineTTL             time.Duration
	StateBytes             int
}
type Stats struct{ Connections, Rooms, Bytes int }
type Hub struct {
	mu          sync.Mutex
	idMu        sync.Mutex
	connections map[*Connection]bool
	rooms       map[string]*room
	unauth      int
	addresses   map[string]int
	closing     bool
	done        chan struct{}
	wg          sync.WaitGroup
	opts        Options
	budget      budget
}
type budget struct {
	mu        sync.Mutex
	used, max int
	cached    int
	pressure  atomic.Uint64
}

func (b *budget) replace(old, next int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if next-old > 0 && b.used+next-old > b.max {
		b.pressure.Add(1)
		return false
	}
	b.used += next - old
	return true
}
func (b *budget) replaceCache(old, next int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	delta := next - old
	if delta > 0 && (b.used+delta > b.max || b.cached+delta > 64*1024*1024) {
		b.pressure.Add(1)
		return false
	}
	b.used += delta
	b.cached += delta
	return true
}
func (b *budget) size() int { b.mu.Lock(); defer b.mu.Unlock(); return b.used }

type Connection struct {
	hub         *Hub
	sender      Sender
	id, address string
	input       sync.Mutex
	// Assigned once before room enqueue. Registry lock protects publication.
	role, peer        string
	room              *room
	authenticated     bool // registry-owned
	departed, closing atomic.Bool
}

func (c *Connection) Authenticated() bool {
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	return c.authenticated && !c.departed.Load() && !c.closing.Load()
}
func (c *Connection) active() bool { return c != nil && !c.departed.Load() && !c.closing.Load() }
func (c *Connection) close(code int, reason string) {
	if c.closing.CompareAndSwap(false, true) {
		c.sender.Close(code, reason)
	}
}
func (c *Connection) send(o object) bool {
	if !c.active() {
		return false
	}
	raw, err := protocol.EncodeWire(o)
	if err != nil {
		c.close(1009, "Message is too large")
		return false
	}
	if err = c.sender.Send(raw); err != nil {
		c.close(1013, "Client is too slow")
		return false
	}
	return true
}
func (c *Connection) error(code, message string) {
	c.send(object{"type": "error", "code": code, "message": message})
}
func (c *Connection) reject(code, message string, closeCode int, reason string) {
	c.error(code, message)
	c.close(closeCode, reason)
}
func New(opts Options) *Hub {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ID == nil {
		opts.ID = func() string {
			b := make([]byte, 16)
			if _, e := rand.Read(b); e != nil {
				panic(e)
			}
			b[6] = (b[6] & 15) | 64
			b[8] = (b[8] & 63) | 128
			return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
		}
	}
	if opts.OfflineTTL <= 0 {
		opts.OfflineTTL = 30 * time.Minute
	}
	if opts.StateBytes <= 0 || opts.StateBytes > MaxStateBytes {
		opts.StateBytes = MaxStateBytes
	}
	return &Hub{connections: map[*Connection]bool{}, rooms: map[string]*room{}, addresses: map[string]int{}, opts: opts, budget: budget{max: opts.StateBytes}, done: make(chan struct{})}
}

// Join reserves pre-authentication capacity. Address must be the actual TCP
// peer address (not a forwarded header); caller strips its ephemeral port.
func (h *Hub) nextID() string { h.idMu.Lock(); defer h.idMu.Unlock(); return h.opts.ID() }
func (h *Hub) Join(sender Sender, address string) (*Connection, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return nil, ErrClosed
	}
	if len(h.connections) >= MaxConnections || h.unauth >= 128 || h.addresses[address] >= 32 {
		return nil, ErrCapacity
	}
	c := &Connection{hub: h, sender: sender, address: address, id: h.nextID()}
	h.connections[c] = true
	h.unauth++
	h.addresses[address]++
	return c, nil
}
func (h *Hub) releaseUnauth(c *Connection) {
	h.unauth--
	h.addresses[c.address]--
	if h.addresses[c.address] == 0 {
		delete(h.addresses, c.address)
	}
}
func (h *Hub) Handle(c *Connection, raw []byte) error {
	if c == nil || c.hub != h {
		return ErrClosed
	}
	c.input.Lock()
	defer c.input.Unlock()
	h.mu.Lock()
	_, present := h.connections[c]
	closing := h.closing
	r := c.room
	h.mu.Unlock()
	if closing || !present || !c.active() {
		return ErrClosed
	}
	m, err := protocol.DecodeWire(raw)
	if err != nil {
		reason := "Invalid relay message"
		if r == nil {
			reason = "Invalid hello message"
		}
		c.reject("INVALID_MESSAGE", err.Error(), 1008, reason)
		return nil
	}
	if r == nil {
		if m["type"] != "hello" {
			c.reject("HELLO_REQUIRED", "The first message must be hello", 1008, "Hello required")
			return nil
		}
		if !roomID.MatchString(m["roomId"].(string)) {
			c.reject("INVALID_ROOM", "Room ID must use letters, numbers, underscore, or hyphen", 1008, "Invalid room")
			return nil
		}
		token := h.opts.ClientToken
		if m["peerRole"] == "host" {
			token = h.opts.HostToken
		}
		if !auth.TokenMatches(m["token"].(string), token) {
			c.reject("UNAUTHORIZED", "Invalid credentials", 1008, "Unauthorized")
			return nil
		}
		// Do not retain hello credentials in actor inboxes/state.
		delete(m, "token")
		h.mu.Lock()
		if h.closing || c.departed.Load() {
			h.mu.Unlock()
			return ErrClosed
		}
		id := m["roomId"].(string)
		r = h.rooms[id]
		if r == nil {
			if len(h.rooms) >= MaxRooms {
				h.mu.Unlock()
				c.reject("ROOM_LIMIT", "The relay has reached its room limit", 1008, "Room limit reached")
				return nil
			}
			r = newRoom(h, id)
			h.rooms[id] = r
			h.wg.Add(1)
			go r.run()
		}
		c.role = m["peerRole"].(string)
		c.peer = m["peerId"].(string)
		c.room = r
		r.refs++
		h.mu.Unlock()
		err = r.call(c, m, len(raw), true)
		h.mu.Lock()
		if err == nil && c.active() && !c.authenticated {
			if _, ok := h.connections[c]; ok {
				c.authenticated = true
				h.releaseUnauth(c)
			}
		}
		h.mu.Unlock()
		return err
	}
	return r.call(c, m, len(raw), false)
}
func (h *Hub) Leave(c *Connection) {
	if c == nil || c.hub != h {
		return
	}
	h.mu.Lock()
	if _, ok := h.connections[c]; !ok {
		h.mu.Unlock()
		return
	}
	delete(h.connections, c)
	if !c.authenticated {
		h.releaseUnauth(c)
	}
	c.departed.Store(true)
	r := c.room
	if r != nil {
		r.refs--
	}
	h.mu.Unlock()
	if r != nil {
		r.wakeUp()
	}
}
func (h *Hub) Stats() Stats {
	h.mu.Lock()
	s := Stats{Connections: len(h.connections), Rooms: len(h.rooms)}
	h.mu.Unlock()
	s.Bytes = h.budget.size()
	return s
}
func (h *Hub) Sync() {
	h.mu.Lock()
	rs := make([]*room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rs = append(rs, r)
	}
	h.mu.Unlock()
	for _, r := range rs {
		ack := make(chan struct{})
		select {
		case r.barriers <- ack:
			select {
			case <-ack:
			case <-r.done:
			}
		case <-r.done:
		}
	}
}
func (h *Hub) Close() {
	h.mu.Lock()
	if h.closing {
		done := h.done
		h.mu.Unlock()
		<-done
		return
	}
	h.closing = true
	cs := make([]*Connection, 0, len(h.connections))
	for c := range h.connections {
		cs = append(cs, c)
	}
	rs := make([]*room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rs = append(rs, r)
	}
	h.mu.Unlock()
	for _, c := range cs {
		c.close(1001, "Server shutting down")
		h.Leave(c)
	}
	for _, r := range rs {
		r.stopOnce.Do(func() { close(r.stop) })
	}
	h.wg.Wait()
	h.mu.Lock()
	h.rooms = map[string]*room{}
	close(h.done)
	h.mu.Unlock()
}
