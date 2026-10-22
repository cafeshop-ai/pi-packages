package collaboration

import (
	"strings"
	"testing"
)

func TestTaskBoardLifecycleAndPermissions(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	ai := join(t, s, id, invite, "Board AI")
	other := join(t, s, id, invite, "Other AI")
	aiToken, aiID, otherToken := ai["token"].(string), ai["memberId"].(string), other["token"].(string)
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); len(features) != 4 || features[3] != "tasks" {
		t.Fatal("status must advertise tasks")
	}
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "source-message", "text": "请整理发布清单"}, owner, 200)
	newTask := map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-create-01", "title": "整理发布清单", "assignee": aiID, "from": 1}
	first := call(t, s, newTask, owner, 200)
	again := call(t, s, newTask, owner, 200)
	if first["id"].(float64) != 1 || again["id"] != first["id"] || first["status"] != "todo" || first["assignee"] != aiID || first["key"] != nil {
		t.Fatalf("create must be idempotent, default to todo and hide keys: %v", first)
	}
	newTask["title"] = "different"
	call(t, s, newTask, owner, 409)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-create-02", "title": "x", "assignee": strings.Repeat("a", 32)}, owner, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-create-03", "title": "x", "from": 9}, owner, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-create-04", "title": ""}, owner, 400)
	second := call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "ai-task-0001", "title": "回归测试"}, aiToken, 200)

	// Any member can move work along; only the creator or owner can delete.
	done := call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "doing"}, aiToken, 200)
	if done["status"] != "doing" || done["assignee"] != aiID {
		t.Fatalf("status update must keep other fields: %v", done)
	}
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "assignee": ""}, otherToken, 200)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "blocked"}, aiToken, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1}, aiToken, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 99, "status": "done"}, aiToken, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "delete", "taskId": 2}, otherToken, 403)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "delete", "taskId": 2}, aiToken, 200)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "archive", "taskId": 1}, owner, 400)
	_ = second

	// Paused AI members cannot change the board; humans still can.
	call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": true}, owner, 200)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "done"}, aiToken, 409)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "done", "title": "整理并核对发布清单"}, owner, 200)

	restarted, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	tasks := call(t, restarted, map[string]any{"op": "read", "roomId": id}, otherToken, 200)["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("board must persist deletions and updates: %v", tasks)
	}
	task := tasks[0].(map[string]any)
	if task["id"].(float64) != 1 || task["status"] != "done" || task["title"] != "整理并核对发布清单" || task["assignee"] != nil || task["from"].(float64) != 1 || task["key"] != nil {
		t.Fatalf("unexpected persisted task: %v", task)
	}
	// IDs are never reused after a deletion.
	call(t, restarted, map[string]any{"op": "pause", "roomId": id, "paused": false}, owner, 200)
	if next := call(t, restarted, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-create-05", "title": "新任务"}, aiToken, 200); next["id"].(float64) != 3 {
		t.Fatalf("task ids must keep increasing: %v", next)
	}
}
