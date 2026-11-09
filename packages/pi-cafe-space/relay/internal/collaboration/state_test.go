package collaboration

import (
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func stateRoom(t *testing.T) (*Store, string, string, string, string) {
	t.Helper()
	s := store(t)
	id, owner := create(t, s)
	ai := join(t, s, id, invitation(t, s, id, owner), "AI")
	ownerID := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["memberId"].(string)
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "request-0001", "text": "请快进 main", "to": ai["memberId"]}, owner, 200)
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "create", "id": "task-000001", "title": "拆分 chunk"}, owner, 200)
	return s, id, owner, ownerID, ai["token"].(string)
}

func TestWaitingStateNamesWhoCanUnblockAndReachesThem(t *testing.T) {
	s, id, owner, ownerID, ai := stateRoom(t)
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); !slices.Contains(features, any("state")) {
		t.Fatal("status must advertise member states")
	}
	wait := map[string]any{"op": "state", "roomId": id, "state": "waiting", "waitingFor": "member", "on": []string{ownerID}, "tasks": []int{1}, "ref": 1, "detail": "等快进 main 到候选 SHA"}
	first := call(t, s, wait, ai, 200)
	if first["state"] != "waiting" || first["since"] == nil || first["since"] != first["updatedAt"] {
		t.Fatalf("state reply: %v", first)
	}
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 1}, owner, 200)
	aiID := page["waitingOnYou"].([]any)
	if len(aiID) != 1 {
		t.Fatalf("the awaited member must see who waits on it: %v", page["waitingOnYou"])
	}
	states := page["states"].(map[string]any)
	if got := states[aiID[0].(string)].(map[string]any); got["detail"] != "等快进 main 到候选 SHA" || got["ref"] != float64(1) || got["waitingFor"] != "member" {
		t.Fatalf("states in read: %v", got)
	}
	if mine := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 1}, ai, 200)["waitingOnYou"].([]any); len(mine) != 0 {
		t.Fatal("nobody waits on the AI")
	}
	// Re-reporting the same wait with new words keeps how long it has lasted; a new target restarts it.
	s.now = func() time.Time { return time.Now().Add(10 * time.Minute) }
	wait["detail"] = "仍在等快进 main"
	again := call(t, s, wait, ai, 200)
	if again["since"] != first["since"] || again["updatedAt"] == first["updatedAt"] {
		t.Fatal("the same wait keeps its start time")
	}
	if idle := call(t, s, map[string]any{"op": "state", "roomId": id, "state": "idle"}, ai, 200); idle["since"] == first["since"] {
		t.Fatal("a new state starts its own clock")
	}
	if left := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 1}, owner, 200)["waitingOnYou"].([]any); len(left) != 0 {
		t.Fatal("a cleared wait no longer points at anyone")
	}
}

func TestStateRejectsVagueOrForeignWaits(t *testing.T) {
	s, id, owner, ownerID, ai := stateRoom(t)
	aiID := call(t, s, map[string]any{"op": "read", "roomId": id}, ai, 200)["memberId"].(string)
	for _, q := range []map[string]any{
		{"state": "busy"},
		{"state": "waiting", "waitingFor": "member", "on": []string{ownerID}},                          // no detail
		{"state": "waiting", "waitingFor": "member", "detail": "等人"},                                   // nobody named
		{"state": "waiting", "waitingFor": "review", "detail": "等复核"},                                  // nobody named
		{"state": "waiting", "waitingFor": "sleep", "detail": "x"},                                     // unknown kind
		{"state": "waiting", "waitingFor": "member", "on": []string{aiID}, "detail": "等自己"},            // self
		{"state": "waiting", "waitingFor": "member", "on": []string{"f" + ownerID[1:]}, "detail": "x"}, // not a member
		{"state": "waiting", "waitingFor": "member", "on": []string{ownerID, ownerID}, "detail": "x"},
		{"state": "working", "waitingFor": "member"},
		{"state": "working", "on": []string{ownerID}},
		{"state": "working", "tasks": []int{9}},
		{"state": "working", "ref": 99},
		{"state": "working", "detail": "line\nbreak"},
		{"state": "away", "expect": time.Now().Add(31 * 24 * time.Hour).Format(time.RFC3339)},
		{"state": "away", "expect": time.Now().Add(-time.Hour).Format(time.RFC3339)},
	} {
		q["op"], q["roomId"] = "state", id
		if v := call(t, s, q, ai, 400); v["error"] != "INVALID_STATE" {
			t.Fatalf("%v: %v", q, v)
		}
	}
	long := make([]rune, maxStateDetail+1)
	for i := range long {
		long[i] = '长'
	}
	call(t, s, map[string]any{"op": "state", "roomId": id, "state": "waiting", "waitingFor": "external", "detail": string(long)}, ai, 400)
	// External, user and decision waits may name nobody; away may say when it returns.
	call(t, s, map[string]any{"op": "state", "roomId": id, "state": "waiting", "waitingFor": "user", "detail": "等本人在本地授权上线"}, ai, 200)
	back := call(t, s, map[string]any{"op": "state", "roomId": id, "state": "away", "detail": "额度用尽", "expect": time.Now().Add(72 * time.Hour).Format(time.RFC3339)}, owner, 200)
	if back["expect"] == nil {
		t.Fatal("away keeps its expected return")
	}
}

func TestStatePersistsWakesWaitersAndLeavesWithTheMember(t *testing.T) {
	s, id, owner, ownerID, ai := stateRoom(t)
	woken := make(chan map[string]any, 1)
	go func() {
		_, page := post(s, map[string]any{"op": "read", "roomId": id, "after": 1, "wait": 5}, owner)
		woken <- page
	}()
	waiters(t, s, 1)
	started := time.Now()
	call(t, s, map[string]any{"op": "state", "roomId": id, "state": "waiting", "waitingFor": "member", "on": []string{ownerID}, "ref": 1, "detail": "等快进"}, ai, 200)
	select {
	case page := <-woken:
		if time.Since(started) > 3*time.Second || len(page["waitingOnYou"].([]any)) != 1 {
			t.Fatalf("a new wait must wake the awaited member's long poll: %v", page["waitingOnYou"])
		}
	case <-time.After(6 * time.Second):
		t.Fatal("state change did not wake the waiting read")
	}
	restored, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := call(t, restored, map[string]any{"op": "read", "roomId": id, "latest": 1}, owner, 200)["waitingOnYou"].([]any); len(got) != 1 {
		t.Fatal("states survive a restart")
	}
	// A paused AI still reports what it is doing.
	call(t, restored, map[string]any{"op": "pause", "roomId": id, "paused": true}, owner, 200)
	call(t, restored, map[string]any{"op": "state", "roomId": id, "state": "idle"}, ai, 200)
	call(t, restored, map[string]any{"op": "state", "roomId": id, "state": "working", "tasks": []int{1}}, ai, 200)
	call(t, restored, map[string]any{"op": "leave", "roomId": id}, ai, 200)
	if states := call(t, restored, map[string]any{"op": "read", "roomId": id, "latest": 1}, owner, 200)["states"].(map[string]any); len(states) != 0 {
		t.Fatalf("a member's state leaves with it: %v", states)
	}
}

func TestStateWriteFailureAndRateLimit(t *testing.T) {
	s, id, owner, _, ai := stateRoom(t)
	directory := s.directory
	s.directory = filepath.Join(t.TempDir(), "missing")
	call(t, s, map[string]any{"op": "state", "roomId": id, "state": "working"}, ai, 503)
	s.directory = directory
	if states := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 1}, owner, 200)["states"].(map[string]any); len(states) != 0 {
		t.Fatal("a failed write must not publish the state")
	}
	// The failed write above already used one of the 30 per minute.
	for i := 0; i < 29; i++ {
		call(t, s, map[string]any{"op": "state", "roomId": id, "state": "working"}, ai, 200)
	}
	call(t, s, map[string]any{"op": "state", "roomId": id, "state": "working"}, ai, 429)
}

func TestSinceAnswersAtOnceForAChangeBetweenReads(t *testing.T) {
	s, id, owner, _, ai := stateRoom(t)
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); !slices.Contains(features, any("rev")) {
		t.Fatal("status must advertise rev")
	}
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 1}, ai, 200)
	rev := int(page["rev"].(float64))
	// The task changes after this read and before the next wait starts: the gap a message cursor cannot see.
	call(t, s, map[string]any{"op": "task", "roomId": id, "action": "update", "taskId": 1, "status": "doing"}, owner, 200)
	started := time.Now()
	next := call(t, s, map[string]any{"op": "read", "roomId": id, "after": page["cursor"], "wait": 5, "since": rev}, ai, 200)
	if time.Since(started) > time.Second || int(next["rev"].(float64)) <= rev || len(next["messages"].([]any)) != 0 {
		t.Fatalf("a change since rev %d must answer at once: %v", rev, next["rev"])
	}
	// Presence is memory-only and never moves the revision.
	call(t, s, map[string]any{"op": "ack", "roomId": id, "fetched": 1, "delivered": 1}, ai, 200)
	current := int(next["rev"].(float64))
	started = time.Now()
	quiet := call(t, s, map[string]any{"op": "read", "roomId": id, "after": next["cursor"], "wait": 1, "since": current}, ai, 200)
	if time.Since(started) < 900*time.Millisecond || int(quiet["rev"].(float64)) != current {
		t.Fatal("with nothing changed since rev, the read waits as before")
	}
	restored, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if again := call(t, restored, map[string]any{"op": "read", "roomId": id, "latest": 1}, ai, 200); int(again["rev"].(float64)) != current {
		t.Fatal("the revision survives a restart")
	}
}
