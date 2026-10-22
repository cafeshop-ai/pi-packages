package collaboration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// post is call without *testing.T, for requests that run in another goroutine.
func post(s *Store, q map[string]any, token string) (int, map[string]any) {
	b, _ := json.Marshal(q)
	r := httptest.NewRequest("POST", endpoint, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return w.Code, result
}
func waiters(t *testing.T, s *Store, n int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		s.mu.Lock()
		got := s.waits
		s.mu.Unlock()
		if got == n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d waiting reads", n)
}

type reply struct {
	status int
	body   map[string]any
}

func TestWaitReturnsOnNewMessageAndTimesOutEmpty(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	ai := join(t, s, id, invitation(t, s, id, owner), "Waiting AI")["token"].(string)
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); len(features) != 3 || features[0] != "wait" {
		t.Fatal("status must advertise wait/ack/pause")
	}
	start := time.Now()
	empty := call(t, s, map[string]any{"op": "read", "roomId": id, "wait": 1}, ai, 200)
	if len(empty["messages"].([]any)) != 0 || empty["cursor"].(float64) != 0 || time.Since(start) < 900*time.Millisecond {
		t.Fatal("an empty wait must hold for the requested time and keep the cursor")
	}
	call(t, s, map[string]any{"op": "read", "roomId": id, "wait": maxWait + 1}, ai, 400)
	done := make(chan reply, 1)
	go func() {
		code, body := post(s, map[string]any{"op": "read", "roomId": id, "wait": 10}, ai)
		done <- reply{code, body}
	}()
	waiters(t, s, 1)
	start = time.Now()
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "wake-the-waiter", "text": "新消息"}, owner, 200)
	select {
	case r := <-done:
		if r.status != 200 || len(r.body["messages"].([]any)) != 1 || time.Since(start) > 2*time.Second {
			t.Fatalf("waiting read did not return the new message promptly: %v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiting read was not woken")
	}
	waiters(t, s, 0)
	// Messages already after the cursor return at once without waiting.
	start = time.Now()
	if got := call(t, s, map[string]any{"op": "read", "roomId": id, "after": 0, "wait": 10}, ai, 200); len(got["messages"].([]any)) != 1 || time.Since(start) > time.Second {
		t.Fatal("pending messages must not wait")
	}
}

func TestWaitEndsOnRemovalAndClosureAndIsBounded(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	a := join(t, s, id, invite, "Removed AI")
	b := join(t, s, id, invite, "Closed AI")["token"].(string)
	removed := make(chan reply, 1)
	go func() {
		code, body := post(s, map[string]any{"op": "read", "roomId": id, "wait": 20}, a["token"].(string))
		removed <- reply{code, body}
	}()
	waiters(t, s, 1)
	call(t, s, map[string]any{"op": "remove", "roomId": id, "memberId": a["memberId"]}, owner, 200)
	if r := <-removed; r.status != 401 {
		t.Fatalf("removed member must be cut off while waiting: %v", r)
	}
	results := make(chan reply, 3)
	for i := 0; i < memberWaits; i++ {
		go func() {
			code, body := post(s, map[string]any{"op": "read", "roomId": id, "wait": 20}, b)
			results <- reply{code, body}
		}()
	}
	waiters(t, s, memberWaits)
	call(t, s, map[string]any{"op": "read", "roomId": id, "wait": 20}, b, 429)
	call(t, s, map[string]any{"op": "close", "roomId": id}, owner, 200)
	for i := 0; i < memberWaits; i++ {
		if r := <-results; r.status != 410 {
			t.Fatalf("closing the room must end waiting reads: %v", r)
		}
	}
	waiters(t, s, 0)
}

func TestWaitOutlivesShortServerTimeouts(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	ai := join(t, s, id, invitation(t, s, id, owner), "Long poll AI")["token"].(string)
	server := httptest.NewUnstartedServer(s.Wrap(http.NotFoundHandler()))
	server.Config.ReadTimeout, server.Config.WriteTimeout = 300*time.Millisecond, 300*time.Millisecond
	server.Start()
	defer server.Close()
	go func() {
		time.Sleep(900 * time.Millisecond)
		post(s, map[string]any{"op": "send", "roomId": id, "id": "after-server-timeouts", "text": "late"}, owner)
	}()
	req, _ := http.NewRequest("POST", server.URL+endpoint, bytes.NewReader([]byte(`{"op":"read","roomId":"`+id+`","wait":5}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+ai)
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&body) != nil || len(body["messages"].([]any)) != 1 {
		t.Fatalf("long poll was cut by server timeouts: %d %v", res.StatusCode, body)
	}
}

func TestPresenceAckAndOwnerPause(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	ai := join(t, s, id, invitation(t, s, id, owner), "Reporting AI")
	token, aiID := ai["token"].(string), ai["memberId"].(string)
	for _, m := range []string{"first-message", "second-message"} {
		call(t, s, map[string]any{"op": "send", "roomId": id, "id": m, "text": m}, owner, 200)
	}
	// Plain reads, such as a browser's, are not a connector reporting presence.
	if view := call(t, s, map[string]any{"op": "read", "roomId": id}, token, 200); len(view["presence"].(map[string]any)) != 0 {
		t.Fatal("reads must not create presence")
	}
	file := filepath.Join(s.directory, id+".json")
	before, _ := os.Stat(file)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "fetched": 2, "delivered": 1}, token, 200)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "fetched": 1, "delivered": 0}, token, 200)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "paused": true}, token, 200)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "fetched": 3}, token, 400)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "delivered": -1}, token, 400)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "seq": 1}, token, 400)
	if after, _ := os.Stat(file); !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Fatal("acks must not rewrite the room file")
	}
	view := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	p := view["presence"].(map[string]any)[aiID].(map[string]any)
	if p["fetched"].(float64) != 2 || p["delivered"].(float64) != 1 || p["paused"] != true || p["heartbeatAt"] == "" {
		t.Fatalf("presence must be monotonic and reflect acks: %v", p)
	}
	call(t, s, map[string]any{"op": "ack", "roomId": id, "delivered": 2}, token, 200)
	call(t, s, map[string]any{"op": "ack", "roomId": id, "fetched": 2, "delivered": 2}, owner, 200)
	if presence := call(t, s, map[string]any{"op": "read", "roomId": id}, token, 200)["presence"].(map[string]any); len(presence) != 2 || presence[aiID].(map[string]any)["delivered"].(float64) != 2 {
		t.Fatal("each member updates only its own presence")
	}
	call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": true}, token, 403)
	call(t, s, map[string]any{"op": "pause", "roomId": id}, owner, 400)
	call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": true}, owner, 200)
	if call(t, s, map[string]any{"op": "read", "roomId": id}, token, 200)["aiPaused"] != true {
		t.Fatal("members must see that AI replies are paused")
	}
	restarted, err := New(s.directory, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	again := call(t, restarted, map[string]any{"op": "read", "roomId": id}, owner, 200)
	if again["aiPaused"] != true || len(again["presence"].(map[string]any)) != 0 {
		t.Fatal("pause persists across restarts; presence starts empty until connectors report")
	}
}

func TestVerifiedMembersHaveTheirOwnQuota(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	for i := 0; i < 240; i++ {
		call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	}
	call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 429)
	// The shared address budget is untouched by the member's reads.
	call(t, s, map[string]any{"op": "status"}, "", 200)
	call(t, s, map[string]any{"op": "read", "roomId": id}, "0000000000000000000000000000000000000000000000000000000000000000", 401)
}
