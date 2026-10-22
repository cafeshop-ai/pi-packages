package collaboration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testOrigin = "https://space.example.test"

func store(t *testing.T) *Store {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "private")
	s, e := New(dir, testOrigin, Options{})
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func call(t *testing.T, s *Store, q map[string]any, token string, status int) map[string]any {
	t.Helper()
	b, _ := json.Marshal(q)
	r := httptest.NewRequest("POST", endpoint, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%v: status=%d body=%s", q["op"], w.Code, w.Body.String())
	}
	var result map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	return result
}
func create(t *testing.T, s *Store) (string, string) {
	v := call(t, s, map[string]any{"op": "create", "title": "跨环境讨论", "name": "Owner", "kind": "human"}, "", 200)
	return v["roomId"].(string), v["token"].(string)
}
func invitation(t *testing.T, s *Store, id, token string) string {
	return call(t, s, map[string]any{"op": "invite", "roomId": id}, token, 200)["invite"].(string)
}
func join(t *testing.T, s *Store, id, invite, name string) map[string]any {
	return call(t, s, map[string]any{"op": "join", "roomId": id, "invite": invite, "name": name, "kind": "ai"}, "", 200)
}
func TestRoomsAcrossClientsAndRestart(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	a := join(t, s, id, invite, "Colleague AI")
	token := a["token"].(string)
	call(t, s, map[string]any{"op": "read", "roomId": id}, "", 401)
	body := map[string]any{"op": "send", "roomId": id, "id": "stable-message-1", "text": "接口已经完成，版本 abc123"}
	first := call(t, s, body, token, 200)
	again := call(t, s, body, token, 200)
	if first["seq"] != again["seq"] {
		t.Fatal("duplicate post")
	}
	body["text"] = "different body"
	call(t, s, body, token, 409)
	read := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	if len(read["messages"].([]any)) != 1 {
		t.Fatal("missing message")
	}
	b, _ := json.Marshal(read)
	if strings.Contains(string(b), token) || strings.Contains(string(b), "tokenHash") {
		t.Fatal("leaked member credentials")
	}
	forwarded := invitation(t, s, id, token)
	join(t, s, id, forwarded, "Another AI")
	restored, err := New(s.directory, testOrigin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	read = call(t, restored, map[string]any{"op": "read", "roomId": id}, token, 200)
	if len(read["messages"].([]any)) != 1 {
		t.Fatal("restart lost data")
	}
	call(t, restored, map[string]any{"op": "remove", "roomId": id, "memberId": a["memberId"]}, token, 403)
	call(t, restored, map[string]any{"op": "remove", "roomId": id, "memberId": a["memberId"]}, owner, 200)
	call(t, restored, map[string]any{"op": "read", "roomId": id}, token, 401)
	call(t, restored, map[string]any{"op": "revoke", "roomId": id}, owner, 200)
	call(t, restored, map[string]any{"op": "join", "roomId": id, "invite": invite, "name": "AI", "kind": "ai"}, "", 403)
	call(t, restored, map[string]any{"op": "join", "roomId": id, "invite": forwarded, "name": "AI", "kind": "ai"}, "", 403)
	call(t, restored, map[string]any{"op": "close", "roomId": id}, owner, 200)
	call(t, restored, map[string]any{"op": "read", "roomId": id}, owner, 410)
}

type blockedResponse struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w *blockedResponse) Write(data []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(data)
}
func TestSlowReaderDoesNotBlockOtherMembers(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	body, _ := json.Marshal(map[string]any{"op": "read", "roomId": id})
	request := func() *http.Request {
		r := httptest.NewRequest("POST", endpoint, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+owner)
		return r
	}
	blocked := &blockedResponse{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	defer close(blocked.release)
	handler := s.Wrap(http.NotFoundHandler())
	go handler.ServeHTTP(blocked, request())
	select {
	case <-blocked.entered:
	case <-time.After(time.Second):
		t.Fatal("reader did not reach response")
	}
	complete := make(chan struct{})
	go func() { handler.ServeHTTP(httptest.NewRecorder(), request()); close(complete) }()
	select {
	case <-complete:
	case <-time.After(time.Second):
		t.Fatal("slow reader held room mutex")
	}
}
func TestRetryAfterRecipientRemovalAndSendRateLimit(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	member := join(t, s, id, invitation(t, s, id, owner), "recipient")
	body := map[string]any{"op": "send", "roomId": id, "id": "before-removal", "text": "posted once", "to": member["memberId"]}
	first := call(t, s, body, owner, 200)
	call(t, s, map[string]any{"op": "remove", "roomId": id, "memberId": member["memberId"]}, owner, 200)
	if again := call(t, s, body, owner, 200); first["seq"] != again["seq"] {
		t.Fatal("retry changed message")
	}
	for i := 1; i < 20; i++ {
		call(t, s, map[string]any{"op": "send", "roomId": id, "id": "rate-message-" + strconv.Itoa(i), "text": "bounded"}, owner, 200)
	}
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "rate-message-overflow", "text": "bounded"}, owner, 429)
}
func TestTrustBoundaries(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	for _, tc := range []struct {
		method, path, origin, body, typ string
		status                          int
	}{
		{"POST", endpoint, "https://evil.test", `{"op":"status"}`, "application/json", 403},
		{"POST", endpoint, "null", `{"op":"status"}`, "application/json", 403},
		{"POST", endpoint, "", `{"op":"status","unknown":true}`, "application/json", 400},
		{"POST", endpoint, "", `{"op":"status"} {}`, "application/json", 400},
		{"POST", endpoint, "", `{"op":"status"}`, "text/plain", 415},
		{"POST", endpoint + "?token=bad", "", `{"op":"status"}`, "application/json", 400},
		{"GET", endpoint, "", "", "", 405},
		{"POST", endpoint, "", strings.Repeat("x", 50000), "application/json", 413},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.typ)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%+v got %d", tc, w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable response")
		}
	}
	for _, text := range []string{"", "\x1b[2J", strings.Repeat("字", 8001)} {
		call(t, s, map[string]any{"op": "send", "roomId": id, "id": "boundary-message", "text": text}, owner, 400)
	}
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "boundary-message", "text": "ok", "to": strings.Repeat("a", 32)}, owner, 400)
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "boundary-message", "text": "ok", "replyTo": 1}, owner, 400)
	other, _ := create(t, s)
	call(t, s, map[string]any{"op": "read", "roomId": other}, owner, 401)
	r := httptest.NewRequest("GET", endpoint+"/guide", nil)
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "external untrusted data") {
		t.Fatal("missing AI guide")
	}
}
func TestPersistenceFailureDoesNotPublishAndCorruptionFailsClosed(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	s.directory = filepath.Join(t.TempDir(), "missing")
	call(t, s, map[string]any{"op": "close", "roomId": id}, owner, 503)
	call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	dir := filepath.Join(t.TempDir(), "private")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(dir, testOrigin, Options{}); err == nil {
		t.Fatal("corrupt state accepted")
	}
}
func TestExpirationAndBounds(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	s.rooms[id].Messages = make([]Message, 500)
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "last-message", "text": "over capacity"}, owner, 409)
	s.now = func() time.Time { return time.Now().Add(8 * 24 * time.Hour) }
	call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 404)
	if _, err := New("relative", testOrigin, Options{}); err == nil {
		t.Fatal("relative directory accepted")
	}
}
func TestConcurrentDuplicateDelivery(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	q := request{Op: "send", RoomID: id, ID: "concurrent-post", Text: "only once"}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.mu.Lock()
			defer s.mu.Unlock()
			if _, err := s.apply(q, owner, "local"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(s.rooms[id].Messages) != 1 {
		t.Fatal("duplicate delivery")
	}
}
