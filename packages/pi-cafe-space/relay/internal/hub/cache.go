package hub

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"time"
)

type cachedResult struct {
	value             object
	bytes, frameBytes int
	history           bool
}

func copyResult(value object, id string, message any) object {
	out := copyObject(value)
	out["requestId"] = id
	out["message"] = message
	return protocol.FitCommandResult(out)
}
func (r *room) clearHistory(h *host) {
	if h.historyList != nil {
		r.hub.budget.replaceCache(h.historyList.bytes, 0)
		h.historyList = nil
	}
	for _, v := range h.histories {
		r.hub.budget.replaceCache(v.bytes, 0)
	}
	h.histories = map[string]cachedResult{}
	h.historyOrder = nil
	h.historyDue = time.Time{}
}
func (r *room) removeResult(h *host, key string) {
	if v, ok := h.results[key]; ok {
		r.hub.budget.replaceCache(v.bytes, 0)
		h.resultBytes -= v.frameBytes
		delete(h.results, key)
		h.resultOrder = removeKey(h.resultOrder, key)
	}
}
func (r *room) clearResults(h *host, historyOnly bool) {
	for _, key := range append([]string{}, h.resultOrder...) {
		if !historyOnly || h.results[key].history {
			r.removeResult(h, key)
		}
	}
}
func (r *room) releaseHost(h *host) {
	r.hub.budget.replace(h.bytes, 0)
	h.bytes = 0
	r.clearResults(h, false)
	r.clearHistory(h)
	for _, p := range h.pending {
		r.hub.budget.replace(p.bytes, 0)
	}
	h.pending = map[string]*pending{}
	h.pendingByKey = map[string]string{}
	h.pendingOrder = nil
}
func (r *room) remember(h *host, key string, value object, history bool) {
	frame := size(value)
	n := frame + len(key) + 128
	old, exists := h.results[key]
	// Enforce baseline per-host FIFO limits before reserving global cache bytes.
	for len(h.resultOrder) > 0 && (len(h.results)+boolInt(!exists) > 1000 || h.resultBytes-old.frameBytes+frame > 8*1024*1024) {
		first := h.resultOrder[0]
		r.removeResult(h, first)
		if first == key {
			exists = false
			old = cachedResult{}
		}
	}
	if !r.hub.budget.replaceCache(old.bytes, n) {
		r.clearHistory(h)
		for len(h.resultOrder) > 0 {
			first := h.resultOrder[0]
			r.removeResult(h, first)
			if first == key {
				exists = false
				old = cachedResult{}
			}
			if r.hub.budget.replaceCache(old.bytes, n) {
				goto reserved
			}
		}
		if !r.hub.budget.replaceCache(old.bytes, n) {
			if h.connection != nil {
				h.connection.close(1013, "Relay cache budget exceeded")
			}
			return
		}
	}
reserved:
	if !exists {
		h.resultOrder = append(h.resultOrder, key)
	}
	h.results[key] = cachedResult{value: value, bytes: n, frameBytes: frame, history: history}
	h.resultBytes += frame - old.frameBytes
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
func (r *room) cacheHistory(h *host, value object, kind string) {
	if value["status"] != "applied" {
		return
	}
	data, ok := value["data"].(object)
	if !ok {
		return
	}
	cached := copyResult(value, "", value["message"])
	n := size(cached) + 128
	if kind == "list" {
		if data["kind"] != "sessions" {
			return
		}
		old := 0
		if h.historyList != nil {
			old = h.historyList.bytes
		}
		if !r.hub.budget.replaceCache(old, n) {
			r.clearHistory(h)
			if !r.hub.budget.replaceCache(0, n) {
				return
			}
		}
		h.historyList = &cachedResult{value: cached, bytes: n}
	} else {
		id, ok := data["sessionId"].(string)
		if data["kind"] != "session" || !ok {
			return
		}
		n += len(id)
		old, exists := h.histories[id]
		if !r.hub.budget.replaceCache(old.bytes, n) {
			r.clearHistory(h)
			exists = false
			if !r.hub.budget.replaceCache(0, n) {
				return
			}
		}
		h.histories[id] = cachedResult{value: cached, bytes: n}
		if !exists {
			h.historyOrder = append(h.historyOrder, id)
		}
		for len(h.historyOrder) > 20 {
			first := h.historyOrder[0]
			entry := h.histories[first]
			r.hub.budget.replaceCache(entry.bytes, 0)
			delete(h.histories, first)
			h.historyOrder = removeKey(h.historyOrder, first)
		}
	}
	h.historyDue = r.hub.opts.Now().Add(30 * time.Minute)
}
func (r *room) cachedHistory(h *host, payload object) object {
	if payload["name"] == "list_sessions" && h.historyList != nil {
		return h.historyList.value
	}
	if payload["name"] == "get_session" {
		return h.histories[payload["sessionId"].(string)].value
	}
	return nil
}
