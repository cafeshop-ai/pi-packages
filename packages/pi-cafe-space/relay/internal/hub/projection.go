package hub

import (
	"crypto/sha256"
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"sort"
)

const snapshotBudget = protocol.MaxFrameBytes - 1024

func copyObject(o object) object {
	out := object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func size(o object) int {
	b, e := protocol.ValueBytes(o)
	if e != nil {
		return protocol.MaxFrameBytes + 1
	}
	return len(b)
}
func truncate(s string, max int) string {
	if protocol.UTF16Length(s) <= max {
		return s
	}
	marker := "\n… [truncated]"
	return protocol.UTF16Prefix(s, max-protocol.UTF16Length(marker)) + marker
}
func compactSnapshot(s object) object {
	out := copyObject(s)
	messages := s["messages"].([]any)
	tools := s["tools"].([]any)
	truncated := s["historyTruncated"] == true
	if len(messages) > 100 {
		messages = messages[len(messages)-100:]
		truncated = true
	}
	if len(tools) > 24 {
		tools = tools[len(tools)-24:]
		truncated = true
	}
	ms, ts := []any{}, []any{}
	for _, v := range messages {
		m := copyObject(v.(object))
		changed := false
		truncated = truncated || m["partsTruncated"] == true
		for _, k := range []string{"text", "thinking"} {
			text := m[k].(string)
			m[k] = truncate(text, 8192)
			truncated = truncated || m[k] != text
			changed = changed || m[k] != text
		}
		if _, ok := m["parts"]; ok && changed {
			delete(m, "parts")
			m["partsTruncated"] = true
		}
		ms = append(ms, m)
	}
	for _, v := range tools {
		m := copyObject(v.(object))
		for _, f := range []struct {
			k   string
			max int
		}{{"argsText", 2048}, {"output", 4096}} {
			text := m[f.k].(string)
			m[f.k] = truncate(text, f.max)
			truncated = truncated || m[f.k] != text
		}
		ts = append(ts, m)
	}
	out["messages"] = ms
	out["tools"] = ts
	out["historyTruncated"] = truncated
	// Removing an array item removes its serialized bytes and one comma.
	// Count once rather than serializing a large projection O(items) times.
	frame := func() int { return size(object{"type": "snapshot", "snapshot": out}) }
	bytes := frame()
	mark := func() {
		if out["historyTruncated"] != true {
			bytes--
			out["historyTruncated"] = true
		}
	}
	for len(ms) > 1 && bytes > snapshotBudget {
		bytes -= size(ms[0].(object)) + 1
		ms = ms[1:]
		out["messages"] = ms
		mark()
	}
	for len(ts) > 0 && bytes > snapshotBudget {
		bytes -= size(ts[0].(object))
		if len(ts) > 1 {
			bytes--
		}
		ts = ts[1:]
		out["tools"] = ts
		mark()
	}
	if bytes > snapshotBudget {
		if len(ms) > 0 {
			ms = ms[len(ms)-1:]
		}
		out["messages"] = ms
		out["tools"] = []any{}
		out["historyTruncated"] = true
	}
	if frame() > snapshotBudget {
		kept := []any{}
		for _, raw := range out["messages"].([]any) {
			m := copyObject(raw.(object))
			if _, ok := m["parts"]; ok {
				delete(m, "parts")
				m["partsTruncated"] = true
			}
			kept = append(kept, m)
		}
		out["messages"] = kept
		out["historyTruncated"] = true
	}
	if frame() > snapshotBudget {
		out["messages"] = []any{}
		out["tools"] = []any{}
		out["historyTruncated"] = true
	}
	// Do not retain backing-array pointers to discarded messages/tools.
	out["messages"] = append([]any{}, out["messages"].([]any)...)
	out["tools"] = append([]any{}, out["tools"].([]any)...)
	return out
}
func historyRevision(s object) string {
	v := object{}
	for _, k := range []string{"streamId", "sessionId", "sessionName", "cwd", "activeLeafId", "model", "thinkingLevel", "messages", "tools", "historyTruncated"} {
		v[k] = s[k]
	}
	b, _ := protocol.ValueBytes(v)
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%x", sum)
}
func (r *room) status() object {
	states := make([]*host, 0, len(r.hosts))
	for _, h := range r.hosts {
		states = append(states, h)
	}
	rank := func(h *host) int {
		if h.connection.active() {
			if h.ready && h.snapshot != nil {
				return 0
			}
			return 1
		}
		return 2
	}
	sort.Slice(states, func(i, j int) bool {
		a, b := states[i], states[j]
		if rank(a) != rank(b) {
			return rank(a) < rank(b)
		}
		return protocol.UTF16Less(a.id, b.id)
	})
	hosts := []any{}
	connected := false
	for _, h := range states {
		online := h.connection.active()
		connected = connected || online
		o := object{"hostId": h.id, "connected": online, "ready": online && h.ready, "streamId": nil, "sessionId": nil, "sessionName": nil, "cwd": nil}
		if h.snapshot != nil {
			for _, k := range []string{"streamId", "sessionId", "cwd"} {
				o[k] = h.snapshot[k]
			}
			if name, ok := h.snapshot["sessionName"].(string); ok && name != "" {
				o["sessionName"] = truncate(name, 240)
			}
		}
		hosts = append(hosts, o)
	}
	out := object{"type": "host_status", "connected": connected, "hostId": nil, "streamId": nil, "sessionId": nil, "hosts": hosts}
	if len(hosts) > 0 {
		primary := hosts[0].(object)
		for _, k := range []string{"hostId", "streamId", "sessionId"} {
			out[k] = primary[k]
		}
	}
	if size(out) <= snapshotBudget {
		return out
	}
	for _, v := range hosts {
		host := v.(object)
		for _, k := range []string{"streamId", "sessionId", "sessionName", "cwd"} {
			host[k] = nil
		}
	}
	out["streamId"] = nil
	out["sessionId"] = nil
	if size(out) > protocol.MaxFrameBytes {
		out["hosts"] = hosts[:1]
	}
	return out
}
