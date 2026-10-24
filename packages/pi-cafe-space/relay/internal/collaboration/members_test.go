package collaboration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShortNamesAndSelfDeclaredAgentLabels(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	joinWith := func(fields map[string]any, status int) map[string]any {
		q := map[string]any{"op": "join", "roomId": id, "invite": invite, "kind": "ai"}
		for k, v := range fields {
			q[k] = v
		}
		return call(t, s, q, "", status)
	}
	// Any name over the limit says so, including names longer than the legacy 48 that old rooms may hold.
	for _, n := range []int{17, 48, 49, 200} {
		if got := joinWith(map[string]any{"name": strings.Repeat("长", n)}, 400); got["error"] != "NAME_TOO_LONG" {
			t.Fatalf("a %d-character name must say so: %v", n, got)
		}
		if got := call(t, s, map[string]any{"op": "create", "title": "x", "name": strings.Repeat("长", n), "kind": "human"}, "", 400); got["error"] != "NAME_TOO_LONG" {
			t.Fatalf("create with a %d-character name must say so: %v", n, got)
		}
	}
	joinWith(map[string]any{"name": strings.Repeat("长", 16)}, 200)
	for _, bad := range []string{"Claude Code", "-pi", strings.Repeat("a", 25), "pi\n"} {
		if got := joinWith(map[string]any{"name": "Agent", "agent": bad}, 400); got["error"] != "INVALID_AGENT" {
			t.Fatalf("agent %q must be refused: %v", bad, got)
		}
	}
	if got := joinWith(map[string]any{"name": "Person", "kind": "human", "agent": "codex"}, 400); got["error"] != "INVALID_AGENT" {
		t.Fatalf("only AI members carry an agent label: %v", got)
	}
	ai := joinWith(map[string]any{"name": "林岚的助手", "agent": "claude-code"}, 200)
	read := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	found := false
	for _, m := range read["members"].([]any) {
		if member := m.(map[string]any); member["id"] == ai["memberId"] {
			found = member["agent"] == "claude-code" && member["name"] == "林岚的助手" && member["tokenHash"] == nil
		}
	}
	if !found {
		t.Fatalf("members must show the agent label and never the token hash: %v", read["members"])
	}
	call(t, s, map[string]any{"op": "create", "title": "x", "name": strings.Repeat("长", 17), "kind": "human"}, "", 400)
	call(t, s, map[string]any{"op": "create", "title": "x", "name": "Owner", "kind": "human", "agent": "codex"}, "", 400)

	// Rooms saved before the limit keep their longer names.
	path := filepath.Join(s.directory, id+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var room map[string]any
	if err := json.Unmarshal(data, &room); err != nil {
		t.Fatal(err)
	}
	room["members"].([]any)[0].(map[string]any)["name"] = "Claude Code（服务器部署执行方 AI）"
	data, _ = json.Marshal(room)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(s.directory, testOrigin, Options{}); err != nil {
		t.Fatalf("a legacy long name must still load: %v", err)
	}
}
