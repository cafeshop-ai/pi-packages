package hub

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"sync"
	"time"
)

type operation struct {
	connection *Connection
	message    object
	bytes      int
	hello      bool
	done       chan struct{}
}
type host struct {
	id                      string
	connection              *Connection
	ready, warned           bool
	snapshot                object
	bytes                   int
	revision                string
	snapshotDue, offlineDue time.Time
	pending                 map[string]*pending
	pendingByKey            map[string]string
	pendingOrder            []string
	results                 map[string]cachedResult
	resultOrder             []string
	resultBytes             int
	historyList             *cachedResult
	histories               map[string]cachedResult
	historyOrder            []string
	historyDue              time.Time
}
type room struct {
	hub                    *Hub
	id                     string
	refs                   int // registry lock only
	inbox                  chan operation
	wake                   chan struct{}
	barriers               chan chan struct{}
	stop, done             chan struct{}
	stopOnce               sync.Once
	inboxMu                sync.Mutex
	inboxCount, inboxBytes int
	// Room-loop-owned below.
	pressureSeen uint64
	members      map[*Connection]bool
	hosts        map[string]*host
	hostOrder    []string
	clients      map[string]*Connection
}

func newRoom(h *Hub, id string) *room {
	return &room{hub: h, id: id, inbox: make(chan operation, MaxInboxCount), wake: make(chan struct{}, 1), barriers: make(chan chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}), members: map[*Connection]bool{}, hosts: map[string]*host{}, clients: map[string]*Connection{}}
}
func (r *room) wakeUp() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
func (r *room) call(c *Connection, m object, n int, hello bool) error {
	op := operation{connection: c, message: m, bytes: n, hello: hello, done: make(chan struct{})}
	r.inboxMu.Lock()
	select {
	case <-r.done:
		r.inboxMu.Unlock()
		return ErrClosed
	case <-r.stop:
		r.inboxMu.Unlock()
		return ErrClosed
	default:
	}
	if r.inboxCount >= MaxInboxCount || r.inboxBytes+n > MaxInboxBytes || !r.hub.budget.replace(0, n) {
		r.inboxMu.Unlock()
		c.close(1013, "Room is overloaded")
		return ErrCapacity
	}
	r.inboxCount++
	r.inboxBytes += n
	r.inbox <- op
	r.inboxMu.Unlock()
	select {
	case <-op.done:
		return nil
	case <-r.done:
		return ErrClosed
	}
}
func (r *room) release(op operation) {
	r.inboxMu.Lock()
	r.inboxCount--
	r.inboxBytes -= op.bytes
	r.inboxMu.Unlock()
	r.hub.budget.replace(op.bytes, 0)
	close(op.done)
}
func (r *room) run() {
	defer r.hub.wg.Done()
	defer func() {
		r.stopOnce.Do(func() { close(r.stop) })
		r.inboxMu.Lock()
		for {
			select {
			case op := <-r.inbox:
				r.hub.budget.replace(op.bytes, 0)
				close(op.done)
			default:
				r.inboxCount = 0
				r.inboxBytes = 0
				r.inboxMu.Unlock()
				for _, h := range r.hosts {
					r.releaseHost(h)
				}
				close(r.done)
				return
			}
		}
	}()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		default:
		}
		// Separate coalesced control lane keeps disconnect/expiry reachable even
		// when an untrusted peer has filled the data lane.
		r.maintain()
		if r.retire() {
			return
		}
		select {
		case <-r.wake:
			continue
		case ack := <-r.barriers:
			r.maintain()
			close(ack)
			continue
		default:
		}
		select {
		case <-r.stop:
			return
		case <-r.wake:
		case <-ticker.C:
		case ack := <-r.barriers:
			r.maintain()
			close(ack)
		case op := <-r.inbox:
			if op.hello {
				r.join(op.connection)
			} else if op.connection.active() {
				r.handle(op.connection, op.message)
			}
			r.release(op)
		}
	}
}
func (r *room) retire() bool {
	if len(r.members) > 0 || len(r.hosts) > 0 {
		return false
	}
	r.hub.mu.Lock()
	defer r.hub.mu.Unlock()
	if r.refs != 0 || r.hub.rooms[r.id] != r {
		return false
	}
	delete(r.hub.rooms, r.id)
	r.stopOnce.Do(func() { close(r.stop) })
	return true
}
func (r *room) broadcast(m object) {
	for _, c := range r.clients {
		c.send(m)
	}
}
func (r *room) maintain() {
	now := r.hub.opts.Now()
	// Cross-room reclaim is coalesced and actor-owned. A failed reservation
	// increments an epoch; never wait for another room while holding registry
	// or budget locks. The overflowing admission is still rejected immediately.
	if epoch := r.hub.budget.pressure.Load(); epoch != r.pressureSeen {
		r.pressureSeen = epoch
		changed := false
		for _, id := range append([]string{}, r.hostOrder...) {
			h := r.hosts[id]
			r.clearHistory(h)
			r.clearResults(h, false)
			if !h.connection.active() && len(h.pending) == 0 {
				r.discardHost(id)
				changed = true
			}
		}
		if changed {
			r.broadcast(r.status())
		}
	}
	for c := range r.members {
		if !c.departed.Load() {
			continue
		}
		delete(r.members, c)
		if c.role == "host" {
			h := r.hosts[c.peer]
			if h != nil && h.connection == c {
				h.connection = nil
				h.ready = false
				h.warned = false
				h.snapshotDue = time.Time{}
				r.completeAll(h, "HOST_OFFLINE", "The Pi host disconnected before acknowledging the command")
				h.offlineDue = now.Add(r.hub.opts.OfflineTTL)
				r.broadcast(r.status())
			}
		}
		if c.role == "client" && r.clients[c.peer] == c {
			delete(r.clients, c.peer)
		}
	}
	for _, id := range append([]string{}, r.hostOrder...) {
		h := r.hosts[id]
		if h == nil {
			continue
		}
		for _, id := range append([]string{}, h.pendingOrder...) {
			p := h.pending[id]
			if p != nil && !now.Before(p.due) {
				r.complete(h, id, rejectedHost(id, "HOST_TIMEOUT", "The Pi host did not acknowledge the command"), "")
			}
		}
		if !h.historyDue.IsZero() && !now.Before(h.historyDue) {
			r.clearHistory(h)
		}
		if h.connection != nil && !h.ready && !h.snapshotDue.IsZero() && !now.Before(h.snapshotDue) {
			h.snapshotDue = time.Time{}
			h.connection.close(1008, "Snapshot required")
		}
		if h.connection == nil && !h.offlineDue.IsZero() && !now.Before(h.offlineDue) {
			r.completeAll(h, "HOST_EXPIRED", "The offline Pi host was retained past its expiry time")
			r.discardHost(id)
			r.broadcast(r.status())
		}
	}
}
func (r *room) discardHost(id string) {
	if h := r.hosts[id]; h != nil {
		r.releaseHost(h)
		delete(r.hosts, id)
	}
	for i, v := range r.hostOrder {
		if v == id {
			r.hostOrder = append(r.hostOrder[:i], r.hostOrder[i+1:]...)
			break
		}
	}
}
func (r *room) join(c *Connection) {
	if !c.active() {
		return
	}
	r.members[c] = true
	if c.role == "client" {
		if r.clients[c.peer] == nil && len(r.clients) >= MaxClients {
			c.reject("CLIENT_LIMIT", "This room has reached its browser client limit", 1008, "Client limit reached")
			return
		}
		if previous := r.clients[c.peer]; previous != nil && previous != c {
			previous.close(1000, "Replaced by reconnect")
		}
		r.clients[c.peer] = c
	} else {
		h := r.hosts[c.peer]
		if h == nil {
			before := len(r.hosts)
			for _, id := range append([]string{}, r.hostOrder...) {
				if len(r.hosts) < MaxHosts {
					break
				}
				old := r.hosts[id]
				if old.connection.active() || len(old.pending) > 0 {
					continue
				}
				if old.connection != nil {
					old.connection.close(1000, "Evicted offline host state")
				}
				r.discardHost(id)
			}
			if len(r.hosts) < before {
				r.broadcast(r.status())
			}
			if len(r.hosts) >= MaxHosts {
				c.reject("HOST_LIMIT", "This room has reached its Pi host limit", 1008, "Host limit reached")
				return
			}
			h = &host{id: c.peer}
			r.hosts[c.peer] = h
			r.hostOrder = append(r.hostOrder, c.peer)
		}
		h.initCommands()
		if h.connection != nil && h.connection != c {
			r.completeAll(h, "HOST_REPLACED", "The Pi host connection was replaced before acknowledging the command")
			h.connection.close(1000, "Replaced by host reconnect")
		}
		r.clearResults(h, false)
		r.clearHistory(h)
		h.connection = c
		h.ready = false
		h.warned = false
		h.offlineDue = time.Time{}
		h.snapshotDue = r.hub.opts.Now().Add(5 * time.Second)
	}
	connected := false
	for _, h := range r.hosts {
		connected = connected || h.connection.active()
	}
	c.send(object{"type": "welcome", "protocolVersion": float64(1), "connectionId": c.id, "peerRole": c.role, "roomId": r.id, "hostConnected": connected})
	if c.role == "host" {
		r.broadcast(r.status())
	} else {
		c.send(r.status())
		for _, id := range r.hostOrder {
			h := r.hosts[id]
			if h.snapshot != nil && (h.connection == nil || h.ready) {
				c.send(object{"type": "snapshot", "hostId": id, "snapshot": h.snapshot})
			}
		}
	}
}
func (r *room) handle(c *Connection, m object) {
	if c.role == "host" {
		h := r.hosts[c.peer]
		if h == nil || h.connection != c {
			c.reject("STALE_HOST", "This host connection is no longer active", 1008, "Stale host connection")
			return
		}
		switch m["type"] {
		case "snapshot":
			r.snapshot(c, h, m["snapshot"].(object))
		case "event":
			r.event(c, h, m)
		case "host_command_result":
			r.complete(h, m["relayRequestId"].(string), m, c.id)
		default:
			c.error("ROLE_VIOLATION", "Host cannot send "+m["type"].(string))
		}
	} else {
		if r.clients[c.peer] != c {
			c.reject("STALE_CLIENT", "This client connection is no longer active", 1008, "Stale client connection")
			return
		}
		if m["type"] == "command" {
			r.routeCommand(c, m)
		} else {
			c.error("ROLE_VIOLATION", "Client cannot send "+m["type"].(string))
		}
	}
}
func (r *room) replaceSnapshot(c *Connection, h *host, next object) bool {
	raw, err := protocol.EncodeWire(object{"type": "snapshot", "snapshot": next})
	if err != nil {
		c.close(1009, "Message is too large")
		return false
	}
	if !r.hub.budget.replace(h.bytes, len(raw)) {
		// Local expired/offline projections are evictable; online state is not
		// silently discarded, and overload closes the source without losing seq.
		for _, id := range append([]string{}, r.hostOrder...) {
			old := r.hosts[id]
			if old != h && !old.connection.active() && len(old.pending) == 0 {
				r.discardHost(id)
			}
		}
		if !r.hub.budget.replace(h.bytes, len(raw)) {
			c.close(1013, "Relay state budget exceeded")
			return false
		}
	}
	h.bytes = len(raw)
	h.snapshot = next
	h.revision = historyRevision(next)
	return true
}
func (r *room) snapshot(c *Connection, h *host, raw object) {
	next := compactSnapshot(raw)
	if old := h.snapshot; old != nil && old["streamId"] == next["streamId"] && old["sessionId"] == next["sessionId"] && next["lastEventSeq"].(float64) < old["lastEventSeq"].(float64) {
		c.reject("STALE_SNAPSHOT", "The snapshot event sequence moved backwards", 1011, "Snapshot event sequence moved backwards")
		return
	}
	nextRevision := historyRevision(next)
	if old := h.snapshot; old != nil {
		identity := old["streamId"] != next["streamId"] || old["sessionId"] != next["sessionId"] || old["cwd"] != next["cwd"]
		if identity {
			code := "STALE_SESSION"
			if old["streamId"] != next["streamId"] {
				code = "STALE_STREAM"
			}
			r.completeAll(h, code, "The Pi session changed before the command completed")
			r.clearResults(h, false)
			r.clearHistory(h)
		} else if h.revision != nextRevision {
			h.revision = nextRevision
			r.clearResults(h, false)
			r.clearHistory(h)
			r.rejectHistory(h)
		}
	}
	if !r.replaceSnapshot(c, h, next) {
		return
	}
	h.ready = true
	h.warned = false
	h.offlineDue = time.Time{}
	h.snapshotDue = time.Time{}
	r.broadcast(object{"type": "snapshot", "hostId": h.id, "snapshot": h.snapshot})
	r.broadcast(r.status())
}
func (r *room) event(c *Connection, h *host, m object) {
	if h.snapshot == nil || !h.ready {
		if !h.warned {
			c.error("SNAPSHOT_REQUIRED", "Send a snapshot before events")
			h.warned = true
		}
		return
	}
	next, err := protocol.ApplyEvent(h.snapshot, m)
	if err != nil {
		r.clearHistory(h)
		r.clearResults(h, false)
		h.ready = false
		h.warned = false
		c.error("EVENT_SEQUENCE", err.Error())
		r.broadcast(r.status())
		c.close(1011, "Event stream is out of sync")
		return
	}
	previousRevision := h.revision
	if !r.replaceSnapshot(c, h, compactSnapshot(next)) {
		return
	}
	if previousRevision != h.revision {
		r.clearHistory(h)
		r.clearResults(h, true)
		r.rejectHistory(h)
	}
	out := object{}
	for k, v := range m {
		out[k] = v
	}
	out["hostId"] = h.id
	if _, err := protocol.EncodeWire(out); err != nil {
		r.broadcast(object{"type": "snapshot", "hostId": h.id, "snapshot": h.snapshot})
	} else {
		r.broadcast(out)
	}
}
