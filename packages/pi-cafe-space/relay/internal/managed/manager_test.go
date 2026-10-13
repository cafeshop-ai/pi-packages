package managed

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if code, handled := RunSupervisor(os.Args[1:]); handled { os.Exit(code) }
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--managed-test-leaf":
			for { time.Sleep(time.Hour) }
		case "--managed-test-tree":
			child := exec.Command(os.Args[0], "--managed-test-leaf")
			if child.Start() != nil { os.Exit(2) }
			fmt.Printf("tree:%d:%d\n", os.Getpid(), child.Process.Pid)
			_, _ = io.Copy(io.Discard, os.Stdin)
			os.Exit(0)
		case "--managed-test-owner":
			child := exec.Command(os.Args[0], "--managed-test-tree")
			child.Stdout, child.Stderr = os.Stdout, os.Stderr
			input, err := child.StdinPipe()
			if err != nil { os.Exit(2) }
			release, err := startOwnedProcess(child)
			if err != nil { os.Exit(2) }
			defer release(); defer input.Close()
			fmt.Printf("supervisor:%d\n", child.Process.Pid)
			for { time.Sleep(time.Hour) }
		}
	}
	if os.Getenv("CAFE_MANAGED_HELPER") == "1" {
		id := ""
		for i, a := range os.Args {
			if a == "--session-id" && i+1 < len(os.Args) {
				id = os.Args[i+1]
			}
		}
		fmt.Println(strings.Repeat("x", 3*1024*1024)) // Oversized native events are drained, not fatal.
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			var q struct {
				ID string `json:"id"`
			}
			json.Unmarshal(scanner.Bytes(), &q)
			fmt.Printf("{\"type\":\"response\",\"id\":%q,\"success\":true,\"data\":{\"sessionId\":%q,\"sessionName\":\"Native title\"}}\n", q.ID, id)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func fixture(t *testing.T) (*Manager, string) {
	t.Helper()
	root := t.TempDir()
	exe, _ := os.Executable()
	entry := filepath.Join(root, "entry.js")
	os.WriteFile(entry, []byte("// synthetic"), 0600)
	cfg := Config{Node: exe, CLI: entry, Extension: entry, AgentDir: root, StateDir: root, Env: map[string]string{"CAFE_MANAGED_HELPER": "1", "SystemRoot": os.Getenv("SystemRoot")}, Projects: []Project{{ID: "project", Name: "Owned project", Room: "room", Cwd: root}}}
	b, _ := json.Marshal(cfg)
	path := filepath.Join(root, "managed.json")
	os.WriteFile(path, b, 0600)
	manager, err := Load(path, "ws://127.0.0.1:1/ws", "synthetic-host-token")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	return manager, path
}
func awaitStatus(t *testing.T, m *Manager, id, status string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		for _, r := range m.records {
			if r.ID == id && r.Status == status {
				m.mu.Unlock()
				return
			}
		}
		m.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status %s not observed", status)
}
func TestOwnedLifecycle(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("unsupported process ownership platform")
	}
	m, path := fixture(t)
	id := "13572468-1234-4123-8123-123456789abc"
	q := Request{Room: "room", Operation: "create", ID: id, ProjectID: "project", Name: "Independent session"}
	a, code := m.Execute(q)
	if code != "" || a.(Record).Status != "starting" {
		t.Fatalf("create %v %s", a, code)
	}
	awaitStatus(t, m, id, "ready")
	if other, err := Load(path, "ws://127.0.0.1:1/ws", "synthetic-host-token"); err == nil {
		other.Close()
		t.Fatal("second registry owner accepted")
	}
	m.mu.Lock()
	pid := m.active[id].cmd.Process.Pid
	m.mu.Unlock()
	m.Execute(q)
	m.mu.Lock()
	if len(m.active) != 1 || m.active[id].cmd.Process.Pid != pid {
		t.Fatal("duplicate create")
	}
	m.mu.Unlock()
	wrong := q
	wrong.Room = "other"
	if _, code = m.Execute(wrong); code == "" {
		t.Fatal("cross room accepted")
	}
	if _, code = m.Execute(Request{Room: "room", Operation: "close", ID: id}); code != "" {
		t.Fatal(code)
	}
	awaitStatus(t, m, id, "stopped")
	m.Close()
	next, err := Load(path, "ws://127.0.0.1:1/ws", "synthetic-host-token")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if len(next.records) != 1 || next.records[0].Status != "stopped" {
		t.Fatal("registry missing")
	}
	if _, code = next.Execute(q); code != "" {
		t.Fatal(code)
	}
	if len(next.active) != 0 {
		t.Fatal("duplicate create after restart launched a process")
	}
	if _, code = next.Execute(Request{Room: "room", Operation: "open", ID: id}); code != "" {
		t.Fatal(code)
	}
	awaitStatus(t, next, id, "ready")
	next.Close()
	awaitStatus(t, next, id, "stopped")
}
func TestAdmissionAndBounds(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("unsupported registry ownership platform")
	}
	m, _ := fixture(t)
	if _, code := m.Execute(Request{Room: "_invalid", Operation: "list"}); code != "INVALID_REQUEST" {
		t.Fatal("room admission diverges from Relay")
	}
	origins, _ := auth.NewOrigins(nil)
	handler := m.Handler("synthetic-client-key", origins)
	for _, tc := range []struct {
		body, origin, token string
		status              int
	}{
		{`{"operation":"list","room":"room"}`, "http://localhost", "Bearer synthetic-client-key", 200},
		{`{"operation":"list","room":"other"}`, "http://localhost", "Bearer synthetic-client-key", 200},
		{`{"operation":"list","room":"room"}`, "http://evil.test", "Bearer synthetic-client-key", 403},
		{`{"operation":"list","room":"room"}`, "", "Bearer synthetic-client-key", 403},
		{`{"operation":"list","room":"room"}`, "http://localhost", "Bearer wrong", 401},
		{`{"operation":"create","room":"room","id":"../../bad","projectId":"project","name":"x"}`, "http://localhost", "Bearer synthetic-client-key", 409},
		{`{"operation":"list","room":"room","cwd":"C:/"}`, "http://localhost", "Bearer synthetic-client-key", 400},
		{strings.Repeat(" ", 4097), "http://localhost", "Bearer synthetic-client-key", 400},
	} {
		r := httptest.NewRequest("POST", "http://localhost/api/workspace", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Authorization", tc.token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%d != %d: %s", w.Code, tc.status, w.Body)
		}
		if strings.Contains(w.Body.String(), "synthetic-host-token") || strings.Contains(w.Body.String(), "agentDir") {
			t.Fatal("private config leaked")
		}
	}
	for i := 0; i < maxSaved; i++ {
		m.records = append(m.records, Record{ID: fmt.Sprintf("%08x-1234-4123-8123-123456789abc", i), ProjectID: "project", Room: "room", Name: "x", HostID: "host", Status: "stopped"})
	}
	if _, code := m.Execute(Request{Room: "room", Operation: "create", ID: "ffffffff-1234-4123-8123-123456789abc", ProjectID: "project", Name: "x"}); code != "MANAGED_LIMIT" {
		t.Fatal(code)
	}
	if _, code := m.Execute(Request{Room: "room", Operation: "create", ID: "ffffffff-1234-4123-8123-123456789abc", ProjectID: "../project", Name: "x"}); code != "PROJECT_UNAVAILABLE" {
		t.Fatal(code)
	}
}
