package collaboration

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); len(features) < 4 || features[3] != "tasks" {
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

	// The assignee moves its own work along; only the creator or owner can delete.
	done := call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "doing"}, aiToken, 200)
	if done["status"] != "doing" || done["assignee"] != aiID {
		t.Fatalf("status update must keep other fields: %v", done)
	}
	// A bystander cannot take someone's task away; the assignee can release it.
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "assignee": ""}, otherToken, 403)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "assignee": ""}, aiToken, 200)
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

func TestTaskClaimPermissionsAndResults(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	first, second := join(t, s, id, invite, "First AI"), join(t, s, id, invite, "Second AI")
	a, aID, b, bID := first["token"].(string), first["memberId"].(string), second["token"].(string), second["memberId"].(string)
	task := func(fields map[string]any, token string, status int) map[string]any {
		t.Helper()
		q := map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1}
		for k, v := range fields {
			q[k] = v
		}
		return call(t, s, q, token, status)
	}
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "claim-task-01", "title": "整理发布说明"}, owner, 200)
	// Nobody but the owner or creator may move an unassigned task except by claiming it.
	task(map[string]any{"status": "done"}, b, 403)

	// Claiming is atomic: the first claimant wins, others get TASK_TAKEN or cannot override.
	if got := task(map[string]any{"assignee": aID, "status": "doing", "onlyIfUnassigned": true}, a, 200); got["assignee"] != aID || got["status"] != "doing" {
		t.Fatalf("claim failed: %v", got)
	}
	task(map[string]any{"assignee": bID, "onlyIfUnassigned": true}, b, 409)
	task(map[string]any{"assignee": bID}, b, 403)
	task(map[string]any{"status": "done"}, b, 403)
	task(map[string]any{"title": "改名"}, a, 403)

	// Results must be the submitter's own message, and a failed update changes nothing.
	foreign := call(t, s, map[string]any{"op": "send", "roomId": id, "id": "foreign-result", "text": "别人的结果"}, b, 200)
	task(map[string]any{"status": "done", "resultSeq": foreign["seq"]}, a, 400)
	task(map[string]any{"status": "done", "resultSeq": 99}, a, 400)
	own := call(t, s, map[string]any{"op": "send", "roomId": id, "id": "own-result-01", "text": "发布说明已整理，见附带清单。"}, a, 200)
	// A completion that repeats the claim fields is still a completion, not a swallowed retry.
	if got := task(map[string]any{"assignee": aID, "onlyIfUnassigned": true, "status": "done", "resultSeq": own["seq"]}, a, 200); got["status"] != "done" || got["result"] != own["seq"] || got["resultBy"] != aID {
		t.Fatalf("result not recorded: %v", got)
	}
	task(map[string]any{"status": "todo", "resultSeq": 99}, a, 400)
	// A retried claim returns the task as it is and never moves done back to doing.
	if got := task(map[string]any{"assignee": aID, "status": "doing", "onlyIfUnassigned": true}, a, 200); got["status"] != "done" {
		t.Fatalf("claim retry regressed the task: %v", got)
	}

	// The owner may reassign, but onlyIfUnassigned still refuses to replace someone.
	task(map[string]any{"assignee": bID, "onlyIfUnassigned": true}, owner, 409)
	// Reassignment keeps the earlier delivery attributed to whoever submitted it.
	if got := task(map[string]any{"assignee": bID}, owner, 200); got["assignee"] != bID || got["result"] != own["seq"] || got["resultBy"] != aID {
		t.Fatalf("owner reassignment failed: %v", got)
	}
	task(map[string]any{"assignee": ""}, a, 403)
	task(map[string]any{"assignee": ""}, b, 200)
}

func TestPreviewShowsMinimalMetadataWithoutJoining(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	join(t, s, id, invite, "Helper AI")
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "secret-history", "text": "只有成员能看到的内容"}, owner, 200)
	preview := call(t, s, map[string]any{"op": "preview", "roomId": id, "invite": invite}, "", 200)
	if preview["title"] != "跨环境讨论" || preview["inviter"] != "Owner" || preview["inviterVerified"] != false || preview["humans"].(float64) != 1 || preview["ais"].(float64) != 1 || preview["messages"].(float64) != 1 {
		t.Fatalf("unexpected preview: %v", preview)
	}
	b, _ := json.Marshal(preview)
	if strings.Contains(string(b), "只有成员能看到的内容") || strings.Contains(string(b), invite) || strings.Contains(string(b), "token") {
		t.Fatal("preview must not reveal history, the invite or credentials")
	}
	if members := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["members"].([]any); len(members) != 2 {
		t.Fatal("preview must not create a member")
	}
	for _, q := range []map[string]any{
		{"op": "preview", "roomId": id, "invite": strings.Repeat("0", 64)},
		{"op": "preview", "roomId": strings.Repeat("f", 32), "invite": invite},
		{"op": "preview", "roomId": id, "invite": "short"},
	} {
		if got := call(t, s, q, "", 403); got["error"] != "INVITE_INVALID" {
			t.Fatalf("preview failures must look alike: %v", got)
		}
	}
	call(t, s, map[string]any{"op": "revoke", "roomId": id}, owner, 200)
	call(t, s, map[string]any{"op": "preview", "roomId": id, "invite": invite}, "", 403)
}

func TestTaskCreateRetryIsRecognisedAfterLaterEdits(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	ai := join(t, s, id, invitation(t, s, id, owner), "Retry AI")
	aiToken, aiID := ai["token"].(string), ai["memberId"].(string)
	original := map[string]any{"op": "task", "roomId": id, "action": "create", "id": "independent-replay", "title": "Original title"}
	first := call(t, s, original, aiToken, 200)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": first["id"], "title": "Renamed later"}, owner, 200)
	// The creation response was lost and the creator retries the same request after someone renamed the task.
	again := call(t, s, original, aiToken, 200)
	if again["id"] != first["id"] || again["title"] != "Renamed later" || again["request"] != nil || again["key"] != nil {
		t.Fatalf("a retry must return the task as it is now, without internals: %v", again)
	}
	for _, other := range []map[string]any{{"title": "Another title"}, {"title": "Original title", "assignee": aiID}, {"title": "Original title", "status": "doing"}} {
		retry := map[string]any{"op": "task", "roomId": id, "action": "create", "id": "independent-replay"}
		for k, v := range other {
			retry[k] = v
		}
		call(t, s, retry, aiToken, 409)
	}
	if tasks := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["tasks"].([]any); len(tasks) != 1 || tasks[0].(map[string]any)["request"] != nil {
		t.Fatalf("no duplicate task and no fingerprint in reads: %v", tasks)
	}

	// A task saved before fingerprints existed keeps the old comparison against its current title.
	path := filepath.Join(s.directory, id+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var room map[string]any
	if err := json.Unmarshal(data, &room); err != nil {
		t.Fatal(err)
	}
	delete(room["tasks"].([]any)[0].(map[string]any), "request")
	data, _ = json.Marshal(room)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	legacy, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	call(t, legacy, original, aiToken, 409)
	original["title"] = "Renamed later"
	if same := call(t, legacy, original, aiToken, 200); same["id"] != first["id"] {
		t.Fatalf("legacy retry must match the current title: %v", same)
	}
}
