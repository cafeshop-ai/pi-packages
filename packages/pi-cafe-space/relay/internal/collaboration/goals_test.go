package collaboration

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func goalChange(t *testing.T, s *Store, room, token, action string, fields map[string]any, status int) map[string]any {
	t.Helper()
	current := call(t, s, map[string]any{"op": "read", "roomId": room}, token, 200)
	q := map[string]any{"op": "goal", "roomId": room, "action": action, "goalRevision": current["goalRevision"]}
	if action != "create" && current["goal"] != nil {
		q["goalId"] = current["goal"].(map[string]any)["id"]
	}
	for k, v := range fields {
		q[k] = v
	}
	return call(t, s, q, token, status)
}

func TestGoalLifecycleHumanReviewAndTaskFences(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	reviewer := call(t, s, map[string]any{"op": "join", "roomId": id, "invite": invite, "name": "Reviewer", "kind": "human"}, "", 200)
	ai := join(t, s, id, invite, "Goal AI")
	a, r := ai["token"].(string), reviewer["token"].(string)
	fields := map[string]any{"title": "Ship a verified release", "criteria": "Tests pass.\nReviewer checks evidence.", "reviewer": reviewer["memberId"]}
	bad := map[string]any{"title": "Goal", "criteria": "Evidence", "reviewer": ai["memberId"]}
	goalChange(t, s, id, owner, "create", bad, 400)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "existing-task", "title": "Run tests"}, owner, 200)
	created := goalChange(t, s, id, a, "create", fields, 200)
	g := created["goal"].(map[string]any)
	if g["status"] != "active" || created["goalRevision"] != float64(1) || created["tasks"].([]any)[0].(map[string]any)["goalId"] != g["id"] {
		t.Fatalf("goal and unfinished board must be linked: %v", created)
	}
	goalChange(t, s, id, owner, "create", fields, 409)
	goalChange(t, s, id, a, "pause", nil, 200)
	goalChange(t, s, id, owner, "pause", nil, 409)
	for _, token := range []string{owner, a} {
		call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "done"}, token, 409)
		call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "paused-task", "title": "New", "goalId": g["id"]}, token, 409)
	}
	goalChange(t, s, id, owner, "resume", map[string]any{"goalRevision": 1}, 409)
	goalChange(t, s, id, owner, "resume", nil, 200)
	goalChange(t, s, id, a, "submit", map[string]any{"resultSeq": 1}, 409)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "done"}, owner, 200)
	foreign := call(t, s, map[string]any{"op": "send", "roomId": id, "id": "foreign-evidence", "text": "Not the submitter's evidence"}, owner, 200)
	goalChange(t, s, id, a, "submit", map[string]any{"resultSeq": foreign["seq"]}, 400)
	evidence := call(t, s, map[string]any{"op": "send", "roomId": id, "id": "goal-evidence", "text": "Checks passed; attached evidence in this message."}, a, 200)
	call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": true}, owner, 200)
	goalChange(t, s, id, a, "submit", map[string]any{"resultSeq": evidence["seq"]}, 409)
	call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": false}, owner, 200)
	goalChange(t, s, id, a, "submit", map[string]any{"resultSeq": evidence["seq"]}, 200)
	goalChange(t, s, id, a, "accept", nil, 403)
	goalChange(t, s, id, owner, "accept", nil, 403) // Owner does not silently become reviewer.
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "delete", "taskId": 1}, owner, 409)
	goalChange(t, s, id, r, "reject", nil, 200)
	goalChange(t, s, id, a, "submit", map[string]any{"resultSeq": evidence["seq"]}, 200)
	accepted := goalChange(t, s, id, r, "accept", nil, 200)
	if accepted["goal"].(map[string]any)["status"] != "done" {
		t.Fatal("human review must complete the goal")
	}
	restarted, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	deleted := goalChange(t, restarted, id, a, "delete", nil, 200)
	if deleted["goal"] != nil || len(deleted["tasks"].([]any)) != 1 {
		t.Fatal("deletion must preserve the board")
	}
	view := call(t, restarted, map[string]any{"op": "read", "roomId": id}, owner, 200)
	if len(view["messages"].([]any)) != 2 || view["goalRevision"].(float64) <= accepted["goalRevision"].(float64) {
		t.Fatal("deletion must preserve chat and advance the revision")
	}
	next := goalChange(t, restarted, id, owner, "create", fields, 200)
	if next["goal"].(map[string]any)["id"] == g["id"] {
		t.Fatal("deleted goal ids must never be reused")
	}
	goalChange(t, restarted, id, owner, "delete", map[string]any{"goalId": g["id"]}, 409)
}

func TestGoalReviewerLeavesAndFailedWritesStayPrivate(t *testing.T) {
	for _, departure := range []string{"leave", "remove"} {
		t.Run(departure, func(t *testing.T) {
			s := store(t)
			id, owner := create(t, s)
			ownerID := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["memberId"]
			r := call(t, s, map[string]any{"op": "join", "roomId": id, "invite": invitation(t, s, id, owner), "name": "Reviewer", "kind": "human"}, "", 200)
			goalChange(t, s, id, owner, "create", map[string]any{"title": "Goal", "criteria": "Evidence", "reviewer": r["memberId"]}, 200)
			if departure == "leave" {
				call(t, s, map[string]any{"op": "leave", "roomId": id}, r["token"].(string), 200)
			} else {
				call(t, s, map[string]any{"op": "remove", "roomId": id, "memberId": r["memberId"]}, owner, 200)
			}
			if s.rooms[id].Goal.Status != "paused" || s.rooms[id].GoalRevision != 2 {
				t.Fatal("loss of the reviewer must pause the goal")
			}
			goalChange(t, s, id, owner, "resume", nil, 409)
			goalChange(t, s, id, owner, "reviewer", map[string]any{"reviewer": ownerID}, 200)
			original := *s.rooms[id].Goal
			revision := s.rooms[id].GoalRevision
			dir := s.directory
			s.directory = filepath.Join(t.TempDir(), "missing")
			goalChange(t, s, id, owner, "resume", nil, 503)
			if *s.rooms[id].Goal != original || s.rooms[id].GoalRevision != revision {
				t.Fatal("failed save changed the live goal")
			}
			s.directory = dir
			goalChange(t, s, id, owner, "resume", nil, 200)
		})
	}
}

func TestGoalChangesWakeReadsWithoutSpendingChatCapacity(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	ownerID := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["memberId"]
	done := make(chan reply, 1)
	go func() {
		status, body := post(s, map[string]any{"op": "read", "roomId": id, "wait": 10}, owner)
		done <- reply{status, body}
	}()
	waiters(t, s, 1)
	goalChange(t, s, id, owner, "create", map[string]any{"title": "Goal", "criteria": "Evidence", "reviewer": ownerID}, 200)
	select {
	case r := <-done:
		if r.status != 200 || r.body["goalRevision"] != float64(1) || len(r.body["messages"].([]any)) != 0 || r.body["cursor"] != float64(0) {
			t.Fatalf("goal change must wake a read independently of chat: %v", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("goal did not wake the long poll")
	}
	for _, bad := range []map[string]any{{"goalRevision": nil}, {"goalRevision": -1}, {"goalId": 999}, {"action": "bogus"}} {
		status := 400
		if bad["goalId"] != nil {
			status = 409
		}
		goalChange(t, s, id, owner, "pause", bad, status)
	}
	for i := 0; i < 500; i++ {
		s.rooms[id].Messages = append(s.rooms[id].Messages, Message{Seq: i + 1, ID: fmt.Sprintf("capacity-%d", i), MemberID: ownerID.(string), Text: "Existing message", At: s.now()})
	}
	goalChange(t, s, id, owner, "pause", nil, 200)
	goalChange(t, s, id, owner, "delete", nil, 200)
	if len(s.rooms[id].Messages) != 500 || s.rooms[id].Version != 2 {
		t.Fatal("full chat must not block control or discard the upgraded storage format")
	}
	goalChange(t, s, id, owner, "create", map[string]any{"title": "Goal", "criteria": strings.Repeat("x", 4001), "reviewer": ownerID}, 400)
	// Legacy rooms (without any Goal fields) still load; malformed goal state does not.
	if !validRoom(s.rooms[id]) {
		t.Fatal("deleted goal room invalid")
	}
	goalChange(t, s, id, owner, "create", map[string]any{"title": "Goal", "criteria": "Evidence", "reviewer": ownerID}, 200)
	s.rooms[id].Goal.Status = "made-up"
	if validRoom(s.rooms[id]) {
		t.Fatal("invalid goal state accepted")
	}
}
