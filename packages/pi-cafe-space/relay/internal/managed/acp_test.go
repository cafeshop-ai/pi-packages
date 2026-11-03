package managed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateACPRuntimePinsReviewedVersions(t *testing.T) {
	root := t.TempDir()
	for path, version := range map[string]string{
		"node_modules/@agentclientprotocol/sdk/package.json":       "2.1.0",
		"node_modules/@agentclientprotocol/codex-acp/package.json": "2.5.0",
	} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(`{"version":"`+version+`"}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateACPRuntime(root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules/@agentclientprotocol/sdk/package.json"), []byte(`{"version":"99.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateACPRuntime(root); err == nil {
		t.Fatal("unreviewed SDK version accepted")
	}
}

func TestACPSocketPathNeedsAbsoluteBoundedValue(t *testing.T) {
	if !validACPSocketPath("") || !validACPSocketPath(filepath.Join(t.TempDir(), "control % &.sock")) {
		t.Fatal("valid optional socket path rejected")
	}
	for _, path := range []string{"relative.sock", filepath.Join(t.TempDir(), "bad\nsocket"), filepath.Join(t.TempDir(), strings.Repeat("x", 4097))} {
		if validACPSocketPath(path) {
			t.Fatalf("invalid socket path accepted: %q", path)
		}
	}
}

func TestAgentTargetKeysSurviveRefreshWithoutExposingNativeIdentity(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	previous := []AgentSession{{ID: id, Key: strings.Repeat("a", 64), ProjectID: "work"}}
	threads := []AgentSession{{ID: id, ProjectID: "work"}, {ID: "22222222-2222-4222-8222-222222222222", ProjectID: "work"}}
	if err := refreshTargetKeys(threads, previous); err != nil {
		t.Fatal(err)
	}
	if threads[0].Key != previous[0].Key || !targetKeyPattern.MatchString(threads[1].Key) || threads[0].Key == threads[1].Key {
		t.Fatal("opaque target keys were not stable and unique")
	}
}

func TestAgentTargetResponseHidesNativeSessionID(t *testing.T) {
	nativeID := "11111111-1111-4111-8111-111111111111"
	encoded, err := json.Marshal(AgentSession{ID: nativeID, Key: strings.Repeat("a", 64), ProjectID: "work", Name: "Task", Cwd: "/work", Status: "idle"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), nativeID) || !strings.Contains(string(encoded), strings.Repeat("a", 64)) {
		t.Fatalf("target projection leaked native ID or omitted lookup key: %s", encoded)
	}
}

func TestTargetOutputProjectionRejectsMalformedAndForeignMetadata(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Projects: []Project{{ID: "work", Name: "Work", Room: "main", Cwd: root}}}}
	valid := `{"type":"cafe_space_targets","threads":[{"id":"11111111-1111-4111-8111-111111111111","projectId":"work","name":"Task","cwd":` + mustJSON(t, root) + `,"status":"idle"}],"truncated":false}`
	threads, truncated, err := m.parseTargetOutput([]byte(valid), "main")
	if err != nil || truncated || len(threads) != 1 || threads[0].Status != "idle" {
		t.Fatalf("valid target rejected: %#v %v", threads, err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"cwd":`+mustJSON(t, root), `"cwd":"C:/outside"`, 1),
		strings.TrimSuffix(valid, "}") + `,"history":"private"}`,
		strings.Replace(valid, `,"truncated":false`, ``, 1),
		strings.Replace(valid, `"status":"idle"`, `"status":"invalid"`, 1),
	} {
		if _, _, err := m.parseTargetOutput([]byte(raw), "main"); err == nil {
			t.Fatalf("invalid target accepted: %s", raw)
		}
	}
	if _, _, err := m.parseTargetOutput([]byte(strings.Repeat("x", maxTargetOutput+1)), "main"); err == nil {
		t.Fatal("oversize target response accepted")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestManagedEnvironmentsCannotReplaceInternalControl(t *testing.T) {
	for _, env := range []map[string]string{
		{"CAFE_ACP_CONFIG_JSON": "override"},
		{"PI_COLLAB_ROOM": "override"},
		{"NODE_OPTIONS": "--require=untrusted"},
		{"PATH": "first", "path": "second"},
		{"SAFE": "contains\x00nul"},
	} {
		if err := validateEnvironment(env); err == nil {
			t.Fatalf("unsafe environment accepted: %#v", env)
		}
	}
	if err := validateEnvironment(map[string]string{"PATH": "/usr/bin", "LANG": "C.UTF-8"}); err != nil {
		t.Fatal(err)
	}
}
