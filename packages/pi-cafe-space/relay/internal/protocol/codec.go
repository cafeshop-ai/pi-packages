package protocol

import (
	"fmt"
	"math"
	"strings"
)

const MaxFrameBytes = 256 * 1024
const MaxEventSequence = 1_000_000_000
const maxText = 65536

type DecodeError struct{ Code, Message string }

func (e *DecodeError) Error() string { return e.Message }
func invalid(message string) error   { return &DecodeError{Code: "INVALID_MESSAGE", Message: message} }
func text(v any, max int, empty bool) bool {
	s, ok := v.(string)
	return ok && (empty || s != "") && stringLen(s) <= max
}
func nullable(o Object, k string, max int) bool {
	v, ok := o[k]
	return ok && (v == nil || text(v, max, true))
}
func boolean(v any) bool { _, ok := v.(bool); return ok }
func finite(v any) bool  { n, ok := v.(float64); return ok && !math.IsNaN(n) && !math.IsInf(n, 0) }
func integer(v any, max float64) bool {
	n, ok := v.(float64)
	return ok && n >= 0 && n <= max && n == math.Trunc(n)
}
func one(v any, choices ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, x := range choices {
		if s == x {
			return true
		}
	}
	return false
}
func optional(o Object, k string, check func(any) bool) bool {
	v, exists := o[k]
	return !exists || check(v)
}
func str(max int) func(any) bool { return func(v any) bool { return text(v, max, false) } }
func phase(v any) bool           { return one(v, "idle", "running", "waiting_local_ui") }
func thinking(v any) bool        { return one(v, "off", "minimal", "low", "medium", "high", "xhigh", "max") }
func role(v any) bool            { return one(v, "host", "client") }
func model(v any) bool {
	if v == nil {
		return true
	}
	o, ok := v.(Object)
	if !ok || !text(o["provider"], 128, false) || !text(o["id"], 256, false) || !optional(o,"reasoning",boolean) { return false }
	if raw, exists := o["thinkingLevels"]; exists {
		levels, valid := raw.([]any); if !valid || len(levels)==0 || len(levels)>7 { return false }
		seen:=map[string]bool{}; for _,level:=range levels { if !thinking(level) { return false }; s:=level.(string); if seen[s] || o["reasoning"]==false && s!="off" { return false }; seen[s]=true }
	}
	return true
}
func hasModel(o Object, k string) bool { v, ok := o[k]; return ok && model(v) }
func selectFields(o Object, keys ...string) Object {
	out := Object{}
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out[k] = v
		}
	}
	return out
}
func canonicalModel(v any) any {
	if v == nil {
		return nil
	}
	return selectFields(v.(Object), "provider", "id", "reasoning", "thinkingLevels")
}
func validParts(v any) bool {
	a, ok := v.([]any)
	if !ok || len(a) > 500 {
		return false
	}
	previous := float64(-1)
	for _, value := range a {
		p, ok := value.(Object)
		if !ok || !integer(p["index"], 499) || p["index"].(float64) <= previous {
			return false
		}
		previous = p["index"].(float64)
		switch p["type"] {
		case "text", "thinking":
			if !text(p["text"], maxText, true) {
				return false
			}
		case "tool-call":
			if !text(p["toolCallId"], 256, false) || !text(p["toolName"], 256, false) || !text(p["argsText"], 4096, true) {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func validMessage(v any) bool {
	o, ok := v.(Object)
	return ok && text(o["id"], 128, false) && one(o["role"], "user", "assistant", "tool", "system") && text(o["text"], maxText, true) && text(o["thinking"], maxText, true) && finite(o["timestamp"]) && one(o["status"], "streaming", "complete", "error") && nullable(o, "toolName", 256) && nullable(o, "toolCallId", 256) && optional(o, "parts", func(v any) bool { return o["role"] == "assistant" && validParts(v) }) && optional(o, "partsTruncated", boolean) && optional(o, "toolIsError", func(v any) bool { return o["role"] == "tool" && boolean(v) })
}
func validTool(v any) bool {
	o, ok := v.(Object)
	return ok && text(o["toolCallId"], 256, false) && text(o["toolName"], 256, false) && text(o["argsText"], maxText, true) && text(o["output"], maxText, true) && one(o["status"], "running", "complete", "error") && optional(o, "parentMessageId", str(128))
}
func array(v any, max int, check func(any) bool) bool {
	a, ok := v.([]any)
	if !ok || len(a) > max {
		return false
	}
	for _, x := range a {
		if !check(x) {
			return false
		}
	}
	return true
}
func validSnapshot(v any) bool {
	o, ok := v.(Object)
	return ok && o["protocolVersion"] == float64(1) && text(o["streamId"], 128, false) && text(o["sessionId"], 256, false) && nullable(o, "sessionName", 256) && text(o["cwd"], 16384, true) && nullable(o, "activeLeafId", 128) && hasModel(o, "model") && thinking(o["thinkingLevel"]) && phase(o["phase"]) && boolean(o["hasPendingMessages"]) && optional(o, "sessionControl", boolean) && optional(o, "inputAssist", boolean) && optional(o,"execution",ValidExecution) && array(o["messages"], 1000, validMessage) && optional(o, "historyTruncated", boolean) && array(o["tools"], 500, validTool) && integer(o["lastEventSeq"], MaxEventSequence)
}
func validHost(v any) bool {
	o, ok := v.(Object)
	return ok && text(o["hostId"], 128, false) && boolean(o["connected"]) && optional(o, "ready", boolean) && nullable(o, "streamId", 128) && nullable(o, "sessionId", 256) && nullable(o, "sessionName", 256) && nullable(o, "cwd", 16384)
}
func validCommand(v any) bool {
	o, ok := v.(Object)
	if !ok {
		return false
	}
	switch o["name"] {
	case "prompt":
		return text(o["content"], maxText, false) && optional(o, "delivery", func(v any) bool { return one(v, "steer", "followUp") }) && optional(o, "files", func(v any) bool { return array(v, 8, str(4096)) })
	case "abort", "list_sessions", "new_session", "list_commands":
		return true
	case "run_command":
		s, ok := o["command"].(string)
		return ok && text(s, maxText, false) && strings.HasPrefix(s, "/") && strings.IndexFunc(s, func(r rune) bool { return r < 9 || r == 11 || r == 12 || (r > 13 && r < 32) || r == 127 }) < 0
	case "rename_session":
		s, ok := o["title"].(string)
		return ok && text(s, 256, false) && strings.Trim(s, "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff") != "" && strings.IndexFunc(s, func(r rune) bool { return r < 32 || r == 127 }) < 0
	case "set_thinking":
		return thinking(o["level"])
	case "set_model":
		return text(o["provider"], 128, false) && text(o["modelId"], 256, false)
	case "list_dir":
		return text(o["path"], 4096, true)
	case "read_file":
		return text(o["path"], 4096, true) && optional(o, "offset", func(v any) bool { return integer(v, 100000000) }) && optional(o, "limit", func(v any) bool { return integer(v, MaxFrameBytes) && v.(float64) > 0 })
	case "get_session", "resume_session":
		return text(o["sessionId"], 256, false)
	}
	return false
}
func validEvent(v any) bool {
	o, ok := v.(Object)
	if !ok {
		return false
	}
	switch o["kind"] {
	case "session_state":
		return phase(o["phase"]) && boolean(o["hasPendingMessages"]) && optional(o,"execution",ValidExecution)
	case "message_started", "message_finished":
		return validMessage(o["message"])
	case "message_delta":
		return text(o["messageId"], 128, false) && one(o["channel"], "text", "thinking") && text(o["delta"], maxText, true) && optional(o, "partIndex", func(v any) bool { return integer(v, 499) })
	case "tool_started", "tool_finished":
		return validTool(o["tool"])
	case "tool_updated":
		return text(o["toolCallId"], 256, false) && text(o["output"], maxText, true)
	case "model_changed":
		return hasModel(o, "model")
	case "thinking_changed":
		return thinking(o["level"])
	case "ui_wait":
		return boolean(o["waiting"]) && nullable(o, "title", 512) && optional(o,"promptKind",promptKind)
	case "notice":
		return one(o["level"], "info", "warning", "error") && text(o["message"], 16384, false)
	}
	return false
}
func canonicalCommand(o Object) Object {
	switch o["name"] {
	case "prompt":
		return selectFields(o, "name", "content", "delivery", "files")
	case "abort", "list_sessions", "new_session", "list_commands":
		return selectFields(o, "name")
	case "run_command":
		return selectFields(o, "name", "command")
	case "rename_session":
		return selectFields(o, "name", "title")
	case "set_thinking":
		return selectFields(o, "name", "level")
	case "set_model":
		return selectFields(o, "name", "provider", "modelId")
	case "list_dir":
		return selectFields(o, "name", "path")
	case "read_file":
		return selectFields(o, "name", "path", "offset", "limit")
	case "get_session", "resume_session":
		return selectFields(o, "name", "sessionId")
	}
	return nil
}
func canonicalMessage(o Object) Object {
	out := selectFields(o, "id", "role", "text", "thinking", "timestamp", "status", "toolName", "toolCallId", "partsTruncated", "toolIsError")
	if a, ok := o["parts"].([]any); ok {
		parts := make([]any, len(a))
		for i, value := range a {
			p := value.(Object)
			if p["type"] == "tool-call" {
				parts[i] = selectFields(p, "index", "type", "toolCallId", "toolName", "argsText")
			} else {
				parts[i] = selectFields(p, "index", "type", "text")
			}
		}
		out["parts"] = parts
	}
	return out
}
func canonicalTool(o Object) Object {
	return selectFields(o, "toolCallId", "toolName", "argsText", "output", "status", "parentMessageId")
}
func canonicalEvent(o Object) Object {
	switch o["kind"] {
	case "session_state":
		out:=selectFields(o,"kind","phase","hasPendingMessages");if state,ok:=o["execution"].(Object);ok{out["execution"]=CanonicalExecution(state)};return out
	case "message_started", "message_finished":
		return Object{"kind": o["kind"], "message": canonicalMessage(o["message"].(Object))}
	case "message_delta":
		return selectFields(o, "kind", "messageId", "channel", "delta", "partIndex")
	case "tool_started", "tool_finished":
		return Object{"kind": o["kind"], "tool": canonicalTool(o["tool"].(Object))}
	case "tool_updated":
		return selectFields(o, "kind", "toolCallId", "output")
	case "model_changed":
		return Object{"kind": o["kind"], "model": canonicalModel(o["model"])}
	case "thinking_changed":
		return selectFields(o, "kind", "level")
	case "ui_wait":
		return selectFields(o, "kind", "waiting", "title", "promptKind")
	case "notice":
		return selectFields(o, "kind", "level", "message")
	}
	return nil
}
func canonicalSnapshot(o Object) Object {
	out := selectFields(o, "protocolVersion", "streamId", "sessionId", "sessionName", "cwd", "activeLeafId", "thinkingLevel", "phase", "hasPendingMessages", "sessionControl", "inputAssist", "lastEventSeq")
	out["model"] = canonicalModel(o["model"])
	if state,ok:=o["execution"].(Object);ok{out["execution"]=CanonicalExecution(state)}
	out["historyTruncated"] = o["historyTruncated"] == true
	messages := []any{}
	for _, v := range o["messages"].([]any) {
		m := canonicalMessage(v.(Object))
		if m["partsTruncated"] == true {
			out["historyTruncated"] = true
		}
		for _, k := range []string{"text", "thinking"} {
			s := m[k].(string)
			m[k] = prefix(s, maxText)
			if m[k] != s {
				out["historyTruncated"] = true
				if _, structured := m["parts"]; structured {
					delete(m, "parts")
					m["partsTruncated"] = true
				}
			}
		}
		messages = append(messages, m)
	}
	tools := []any{}
	for _, v := range o["tools"].([]any) {
		m := canonicalTool(v.(Object))
		for _, k := range []string{"argsText", "output"} {
			s := m[k].(string)
			m[k] = prefix(s, maxText)
			if m[k] != s {
				out["historyTruncated"] = true
			}
		}
		tools = append(tools, m)
	}
	out["messages"] = messages
	out["tools"] = tools
	return out
}

type budget struct{ nodes, bytes int }

func normalizeJSON(v any, depth int, b *budget) (any, bool) {
	b.nodes++
	if b.nodes > 20000 {
		return nil, false
	}
	switch x := v.(type) {
	case nil, bool:
		return v, true
	case float64:
		return v, finite(v)
	case string:
		b.bytes += len(x)
		return v, stringLen(x) <= MaxFrameBytes && b.bytes <= MaxFrameBytes
	case []any:
		if depth > 8 || len(x) > 500 {
			return nil, false
		}
		a := make([]any, len(x))
		for i, v := range x {
			n, ok := normalizeJSON(v, depth+1, b)
			if !ok {
				return nil, false
			}
			a[i] = n
		}
		return a, true
	case Object:
		if depth > 8 || len(x) > 500 {
			return nil, false
		}
		o := Object{}
		for k, v := range x {
			b.bytes += len(k)
			if stringLen(k) > 4096 || b.bytes > MaxFrameBytes {
				return nil, false
			}
			n, ok := normalizeJSON(v, depth+1, b)
			if !ok {
				return nil, false
			}
			o[k] = n
		}
		return o, true
	}
	return nil, false
}
func resultData(o Object) bool {
	v, ok := o["data"]
	if !ok {
		return true
	}
	_, valid := normalizeJSON(v, 0, &budget{})
	return valid
}
func resultFields(o Object, id string) bool {
	return text(o[id], 128, false) && one(o["status"], "dispatched", "applied", "rejected") && nullable(o, "code", 128) && nullable(o, "message", 2048) && resultData(o)
}

// DecodeWire accepts a JSON string's UTF-8 bytes. Transport performs fatal decoding
// and strips an initial UTF-8 BOM before calling it, just as the TS TextDecoder does.
func DecodeWire(raw []byte) (Object, error) {
	if len(raw) > MaxFrameBytes {
		return nil, invalid("Message exceeds the relay frame limit")
	}
	v, err := parseJSON(raw)
	if err != nil {
		return nil, invalid("Message is not valid JSON")
	}
	o, ok := v.(Object)
	if !ok || !text(o["type"], 64, false) {
		return nil, invalid("Message must be an object with a type")
	}
	valid := false
	switch o["type"] {
	case "hello":
		valid = o["protocolVersion"] == float64(1) && role(o["peerRole"]) && text(o["peerId"], 128, false) && text(o["roomId"], 128, false) && text(o["token"], 4096, false)
	case "welcome":
		valid = o["protocolVersion"] == float64(1) && text(o["connectionId"], 128, false) && role(o["peerRole"]) && text(o["roomId"], 128, false) && boolean(o["hostConnected"])
	case "host_status":
		valid = boolean(o["connected"]) && nullable(o, "streamId", 128) && nullable(o, "sessionId", 256) && optional(o, "hostId", func(v any) bool { return v == nil || text(v, 128, true) }) && optional(o, "hosts", func(v any) bool { return array(v, 64, validHost) })
	case "snapshot":
		valid = optional(o, "hostId", str(128)) && validSnapshot(o["snapshot"])
	case "event":
		valid = optional(o, "hostId", str(128)) && text(o["streamId"], 128, false) && text(o["sessionId"], 256, false) && integer(o["seq"], MaxEventSequence) && text(o["emittedAt"], 64, false) && validEvent(o["event"])
	case "command", "routed_command":
		valid = text(o["expectedStreamId"], 128, false) && optional(o, "expectedSessionId", str(256)) && optional(o, "expectedCwd", str(16384)) && optional(o, "targetHostId", str(128)) && validCommand(o["payload"])
		if o["type"] == "command" {
			valid = valid && text(o["requestId"], 128, false)
		} else {
			valid = valid && text(o["relayRequestId"], 128, false) && text(o["clientRequestId"], 128, false) && text(o["sourcePeerId"], 128, false)
		}
	case "host_command_result":
		valid = resultFields(o, "relayRequestId")
	case "command_result":
		valid = resultFields(o, "requestId") && optional(o, "hostId", str(128))
	case "error":
		valid = text(o["code"], 128, false) && text(o["message"], 2048, false)
	}
	if !valid {
		return nil, invalid(fmt.Sprintf("Invalid %s message", o["type"]))
	}
	return canonicalWire(o), nil
}
func canonicalWire(o Object) Object {
	switch o["type"] {
	case "hello":
		return selectFields(o, "type", "protocolVersion", "peerRole", "peerId", "roomId", "token")
	case "welcome":
		return selectFields(o, "type", "protocolVersion", "connectionId", "peerRole", "roomId", "hostConnected")
	case "host_status":
		out := selectFields(o, "type", "connected", "streamId", "sessionId", "hostId")
		if a, ok := o["hosts"].([]any); ok {
			hosts := []any{}
			for _, h := range a {
				hosts = append(hosts, selectFields(h.(Object), "hostId", "connected", "ready", "streamId", "sessionId", "sessionName", "cwd"))
			}
			out["hosts"] = hosts
		}
		return out
	case "snapshot":
		out := selectFields(o, "type", "hostId")
		out["snapshot"] = canonicalSnapshot(o["snapshot"].(Object))
		return out
	case "event":
		out := selectFields(o, "type", "hostId", "streamId", "sessionId", "seq", "emittedAt")
		out["event"] = canonicalEvent(o["event"].(Object))
		return out
	case "command", "routed_command":
		keys := []string{"type", "expectedStreamId", "expectedSessionId", "expectedCwd", "targetHostId"}
		if o["type"] == "command" {
			keys = append(keys, "requestId")
		} else {
			keys = append(keys, "relayRequestId", "clientRequestId", "sourcePeerId")
		}
		out := selectFields(o, keys...)
		out["payload"] = canonicalCommand(o["payload"].(Object))
		return out
	case "host_command_result", "command_result":
		keys := []string{"type", "status", "code", "message"}
		if o["type"] == "command_result" {
			keys = append(keys, "hostId", "requestId")
		} else {
			keys = append(keys, "relayRequestId")
		}
		out := selectFields(o, keys...)
		if v, ok := o["data"]; ok {
			out["data"], _ = normalizeJSON(v, 0, &budget{})
		}
		return out
	case "error":
		return selectFields(o, "type", "code", "message")
	}
	return nil
}
func EncodeWire(o Object) ([]byte, error) {
	raw, err := stringify(o)
	if err != nil {
		return nil, err
	}
	canonical, err := DecodeWire(raw)
	if err != nil {
		return nil, err
	}
	return stringify(canonical)
}
func FitCommandResult(o Object) Object {
	typ := "command_result"
	id := "requestId"
	if o["type"] == "host_command_result" {
		typ = "host_command_result"
		id = "relayRequestId"
	}
	out := Object{"type": typ, id: "", "status": "rejected", "code": nil, "message": nil}
	if one(o["status"], "dispatched", "applied", "rejected") {
		out["status"] = o["status"]
	}
	for _, f := range []struct {
		k   string
		max int
	}{{id, 128}, {"code", 128}, {"message", 2048}} {
		if s, ok := o[f.k].(string); ok {
			out[f.k] = prefix(s, f.max)
		}
	}
	if s, ok := o["hostId"].(string); ok && typ == "command_result" {
		out["hostId"] = prefix(s, 128)
	}
	valid := true
	if v, ok := o["data"]; ok {
		var normalized any
		normalized, valid = normalizeJSON(v, 0, &budget{})
		if valid {
			out["data"] = normalized
		}
	}
	raw, err := stringify(out)
	if valid && err == nil && len(raw) <= MaxFrameBytes-1024 {
		return out
	}
	out["status"] = "rejected"
	out["code"] = "RESULT_TOO_LARGE"
	out["message"] = "The command result exceeded the relay frame limit"
	delete(out, "data")
	if out["hostId"] == "" {
		delete(out, "hostId")
	}
	return out
}
