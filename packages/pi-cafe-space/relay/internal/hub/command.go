package hub

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"time"
)

type pending struct {
	peer, clientID, hostID, request, key, revision, historyKind, historySession string
	due                                                                         time.Time
	bytes                                                                       int
}

func (h *host) initCommands() {
	if h.pending == nil {
		h.pending = map[string]*pending{}
		h.pendingByKey = map[string]string{}
		h.results = map[string]cachedResult{}
		h.histories = map[string]cachedResult{}
	}
}
func removeKey(a []string, key string) []string {
	for i, v := range a {
		if v == key {
			copy(a[i:], a[i+1:])
			a[len(a)-1] = ""
			return a[:len(a)-1]
		}
	}
	return a
}
func rejectedHost(id, code, message string) object {
	return object{"type": "host_command_result", "relayRequestId": id, "status": "rejected", "code": code, "message": message}
}
func (r *room) completeAll(h *host, code, message string) {
	for _, id := range append([]string{}, h.pendingOrder...) {
		r.complete(h, id, rejectedHost(id, code, message), "")
	}
}
func (r *room) rejectHistory(h *host) {
	for _, id := range append([]string{}, h.pendingOrder...) {
		if p := h.pending[id]; p != nil && p.historyKind != "" {
			r.complete(h, id, rejectedHost(id, "STALE_SESSION", "The Pi session projection changed before the history command completed"), "")
		}
	}
}
func (r *room) complete(h *host, id string, result object, hostConnectionID string) {
	p := h.pending[id]
	if p == nil || (hostConnectionID != "" && p.hostID != hostConnectionID) {
		return
	}
	delete(h.pending, id)
	if h.pendingByKey[p.key] == id {
		delete(h.pendingByKey, p.key)
	}
	h.pendingOrder = removeKey(h.pendingOrder, id)
	r.hub.budget.replace(p.bytes, 0)
	stale := p.historyKind != "" && p.revision != h.revision
	invalid := false
	if p.historyKind != "" && result["status"] == "applied" {
		data, ok := result["data"].(object)
		invalid = !ok
		if ok {
			if p.historyKind == "list" {
				invalid = data["kind"] != "sessions"
			} else {
				invalid = data["kind"] != "session" || data["sessionId"] != p.historySession
			}
		}
	}
	effective := result
	if stale {
		effective = rejectedHost(id, "STALE_SESSION", "The Pi session projection changed before the history command completed")
	} else if invalid {
		effective = rejectedHost(id, "RESULT_INVALID", "The Pi host returned an invalid history result")
	}
	out := object{"type": "command_result", "hostId": h.id, "requestId": p.request, "status": effective["status"], "code": effective["code"], "message": effective["message"]}
	if data, ok := effective["data"]; ok {
		out["data"] = data
	}
	out = protocol.FitCommandResult(out)
	if !stale {
		if p.historyKind != "" {
			r.cacheHistory(h, out, p.historyKind)
		}
		r.remember(h, p.key, out, p.historyKind != "")
	}
	if c := r.clients[p.peer]; c != nil && c.id == p.clientID {
		c.send(out)
	}
}
func (r *room) findHost(m object) *host {
	if target, ok := m["targetHostId"].(string); ok && target != "" {
		return r.hosts[target]
	}
	stream, exact := []*host{}, []*host{}
	session, fenced := m["expectedSessionId"]
	for _, id := range r.hostOrder {
		h := r.hosts[id]
		if h.snapshot == nil || h.snapshot["streamId"] != m["expectedStreamId"] {
			continue
		}
		stream = append(stream, h)
		if !fenced || h.snapshot["sessionId"] == session {
			exact = append(exact, h)
		}
	}
	if len(exact) == 1 {
		return exact[0]
	}
	if fenced && len(stream) == 1 {
		return stream[0]
	}
	return nil
}
func (r *room) routeCommand(c *Connection, m object) {
	keyBytes, _ := protocol.ValueBytes([]any{c.peer, m["requestId"]})
	key := string(keyBytes)
	target, _ := m["targetHostId"].(string)
	var h *host
	matches := []*host{}
	if target == "" {
		for _, id := range r.hostOrder {
			candidate := r.hosts[id]
			_, cached := candidate.results[key]
			if cached || candidate.pendingByKey[key] != "" {
				matches = append(matches, candidate)
			}
		}
		if len(matches) == 1 {
			h = matches[0]
		}
	}
	if h == nil && len(matches) <= 1 {
		h = r.findHost(m)
	}
	reply := func(code, message string) {
		out := object{"type": "command_result", "requestId": m["requestId"], "status": "rejected", "code": code, "message": message}
		if h != nil {
			out["hostId"] = h.id
		} else if target != "" {
			out["hostId"] = target
		}
		c.send(out)
	}
	if h == nil {
		active, streams := 0, 0
		for _, candidate := range r.hosts {
			if candidate.connection.active() {
				active++
			}
			if target == "" && candidate.snapshot != nil && candidate.snapshot["streamId"] == m["expectedStreamId"] {
				streams++
			}
		}
		if target != "" {
			reply("HOST_NOT_FOUND", "The selected Pi host is not available")
		} else if len(matches) > 1 || streams > 1 || active > 1 {
			reply("HOST_SELECTION_REQUIRED", "More than one Pi host matches this command; select a host before sending a command")
		} else {
			reply("HOST_OFFLINE", "The Pi host is not connected")
		}
		return
	}
	h.initCommands()
	s := h.snapshot
	hc := h.connection
	notReady := func() {
		reply("HOST_NOT_READY", "The selected Pi host is reconnecting and has not sent its current snapshot yet")
	}
	if hc != nil && (!h.ready || s == nil) {
		notReady()
		return
	}
	if s != nil {
		stream := m["expectedStreamId"] != s["streamId"]
		session := false
		cwd := false
		if v, ok := m["expectedSessionId"]; ok {
			session = v != s["sessionId"]
		}
		if v, ok := m["expectedCwd"]; ok {
			cwd = v != s["cwd"]
		}
		if stream || session || cwd {
			code := "STALE_STREAM"
			if session || cwd {
				code = "STALE_SESSION"
			}
			message := "The selected Pi session changed; refresh and retry"
			if cwd {
				message = "The selected Pi project changed; refresh and retry"
			}
			reply(code, message)
			c.send(object{"type": "snapshot", "hostId": h.id, "snapshot": compactSnapshot(s)})
			return
		}
	}
	if previous, ok := h.results[key]; ok {
		c.send(copyResult(previous.value, m["requestId"].(string), previous.value["message"]))
		return
	}
	if id := h.pendingByKey[key]; id != "" {
		if p := h.pending[id]; p != nil {
			p.clientID = c.id
		}
		c.send(object{"type": "command_result", "hostId": h.id, "requestId": m["requestId"], "status": "dispatched", "code": "REQUEST_PENDING", "message": "This request is already pending"})
		return
	}
	payload := m["payload"].(object)
	if cached := r.cachedHistory(h, payload); cached != nil && !hc.active() {
		h.historyDue = r.hub.opts.Now().Add(30 * time.Minute)
		h.offlineDue = r.hub.opts.Now().Add(r.hub.opts.OfflineTTL)
		c.send(copyResult(cached, m["requestId"].(string), "Served from relay cache"))
		return
	}
	if !hc.active() {
		reply("HOST_OFFLINE", "The selected Pi host is not connected")
		return
	}
	if !h.ready || s == nil {
		notReady()
		return
	}
	_, hasFiles := payload["files"]
	if payload["name"] == "list_commands" || payload["name"] == "run_command" || payload["name"] == "prompt" && hasFiles {
		if s["inputAssist"] != true {
			reply("INPUT_ASSIST_UNAVAILABLE", "Reload Pi to enable commands and file references")
			return
		}
		if m["expectedSessionId"] == nil || m["expectedCwd"] == nil {
			reply("STALE_SESSION", "Input actions require explicit session and project fences")
			return
		}
		if payload["name"] == "run_command" && (s["phase"] != "idle" || s["hasPendingMessages"] != false) {
			reply("SESSION_BUSY", "Wait for Pi to finish before running a command")
			return
		}
	}
	if payload["name"] == "new_session" || payload["name"] == "rename_session" || payload["name"] == "resume_session" {
		if s["sessionControl"] != true {
			reply("SESSION_CONTROL_UNAVAILABLE", "Reload the Pi extension to enable session controls")
			return
		}
		if m["expectedSessionId"] == nil || m["expectedCwd"] == nil {
			reply("STALE_SESSION", "Session controls require explicit session and project fences")
			return
		}
		if s["phase"] != "idle" || s["hasPendingMessages"] != false {
			reply("SESSION_BUSY", "Wait for Pi to finish before changing sessions")
			return
		}
	}
	count := 0
	for _, p := range h.pending {
		if p.peer == c.peer {
			count++
		}
	}
	if len(h.pending) >= 128 || count >= 32 {
		reply("COMMAND_QUEUE_FULL", "Too many commands are already waiting for this Pi host")
		return
	}
	id := r.hub.nextID()
	routed := object{"type": "routed_command", "relayRequestId": id, "clientRequestId": m["requestId"], "sourcePeerId": c.peer, "expectedStreamId": m["expectedStreamId"], "targetHostId": h.id, "payload": payload}
	for _, k := range []string{"expectedSessionId", "expectedCwd"} {
		if v, ok := m[k]; ok {
			routed[k] = v
		}
	}
	raw, err := protocol.EncodeWire(routed)
	if err != nil {
		reply("COMMAND_TOO_LARGE", "The command exceeded the relay frame limit after routing")
		return
	}
	p := &pending{peer: c.peer, clientID: c.id, hostID: hc.id, request: m["requestId"].(string), key: key, revision: h.revision, due: r.hub.opts.Now().Add(15 * time.Second), bytes: len(raw) + 1024}
	if payload["name"] == "list_sessions" {
		p.historyKind = "list"
	} else if payload["name"] == "get_session" {
		p.historyKind = "get"
		p.historySession = payload["sessionId"].(string)
	}
	if !r.hub.budget.replace(0, p.bytes) {
		r.clearHistory(h)
		r.clearResults(h, false)
		if !r.hub.budget.replace(0, p.bytes) {
			c.close(1013, "Relay state budget exceeded")
			return
		}
	}
	h.pending[id] = p
	h.pendingByKey[key] = id
	h.pendingOrder = append(h.pendingOrder, id)
	if !hc.send(routed) {
		r.complete(h, id, rejectedHost(id, "HOST_OFFLINE", "The Pi host could not receive the command"), "")
	}
}
