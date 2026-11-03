package remote

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"strings"
	"sync"
	"testing"
)

type roomManagerFixture struct {
	mu       sync.Mutex
	requests []managed.Request
}

func (m *roomManagerFixture) Execute(q managed.Request) (any, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests = append(m.requests, q)
	if q.Operation == "create" && q.ProjectID != "approved" {
		return nil, "PROJECT_NOT_ALLOWED"
	}
	return map[string]any{"accepted": true}, ""
}
func TestWorkspaceRequestUsesOpaqueTargetKey(t *testing.T) {
	key := strings.Repeat("a", 64)
	body := []byte(`{"type":"remote.workspace","requestId":"attach","request":{"room":"main","operation":"create","id":"12345678-1234-4123-8123-123456789abc","projectId":"work","name":"Borrowed","agent":"codex-acp","targetKey":"` + key + `"}}`)
	var message workspaceMessage
	if err := strictJSON(body, &message); err != nil || message.Request.TargetKey != key {
		t.Fatalf("opaque target key did not decode: %#v %v", message, err)
	}
	legacy := []byte(strings.Replace(string(body), `"targetKey":"`+key+`"`, `"threadId":"87654321-4321-4abc-8def-123456789abc"`, 1))
	if err := strictJSON(legacy, &workspaceMessage{}); err == nil {
		t.Fatal("legacy native session ID field accepted")
	}
}

func TestRoomManagedRequiresExplicitCapabilityWithoutAdminEscalation(t *testing.T) {
	manager := &roomManagerFixture{}
	f := roomFixture(t, false, manager)
	r := connectRoom(t, f, false)
	r.authenticate("123456")
	info := r.receive("room.authenticated")
	if info["role"] != "operator" || info["managed"] != true {
		t.Fatal("wrong explicit capability", info)
	}
	r.hello()
	send := func(id, operation, room, project string) map[string]any {
		q := map[string]any{"room": room, "operation": operation}
		if project != "" {
			q["projectId"] = project
		}
		r.send(map[string]any{"type": "remote.workspace", "requestId": id, "request": q})
		return r.receive("remote.result")
	}
	for _, op := range []string{"list", "threads", "create", "open"} {
		if result := send(op, op, "main", "approved"); result["ok"] != true {
			t.Fatal("explicit operation rejected", op, result)
		}
	}
	if result := send("outside", "create", "main", "outside"); result["code"] != "PROJECT_NOT_ALLOWED" {
		t.Fatal("project whitelist bypassed")
	}
	manager.mu.Lock()
	before := len(manager.requests)
	manager.mu.Unlock()
	if result := send("close", "close", "main", ""); result["code"] != "FORBIDDEN" {
		t.Fatal("operator closed another instance")
	}
	if result := send("other-room", "list", "other", ""); result["code"] != "FORBIDDEN" {
		t.Fatal("cross-room manager access")
	}
	r.send(control("force", "pi-a", "acquire", true))
	if result := r.receive("remote.result"); result["code"] != "FORBIDDEN" {
		t.Fatal("manager capability escalated control")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.requests) != before {
		t.Fatal("denied operation reached manager")
	}
}
func TestRoomManagedDefaultIsDisabled(t *testing.T) {
	f := roomFixture(t, false)
	r := connectRoom(t, f, false)
	r.authenticate("123456")
	info := r.receive("room.authenticated")
	if info["managed"] != false {
		t.Fatal("management enabled by default")
	}
	r.hello()
	r.send(map[string]any{"type": "remote.workspace", "requestId": "denied", "request": map[string]any{"room": "main", "operation": "create", "projectId": "unapproved"}})
	if result := r.receive("remote.result"); result["code"] != "MANAGED_UNAVAILABLE" {
		t.Fatal("default room allowed instance creation", result)
	}
	cfg := f.agent.cfg
	cfg.RoomManagement = true
	if _, err := NewAgent(cfg, AgentBackend{Hub: f.h, ClientToken: "123456"}); err == nil {
		t.Fatal("capability accepted without manager configuration")
	}
	cloud := f.cfg
	cloud.RoomManagement = true
	if cloud.Validate() == nil {
		t.Fatal("cloud attempted to grant office process permission")
	}
}
