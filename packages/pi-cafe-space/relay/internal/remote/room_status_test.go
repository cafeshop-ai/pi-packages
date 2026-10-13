package remote

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRoomStatusBeforePasswordDoesNotCreateVisitor(t *testing.T) {
	f := roomFixture(t, false)
	key, _ := f.agent.room.snapshot()
	call := func(key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", f.server.URL+"/api/room/status", strings.NewReader(`{"roomKey":"`+key+`"}`))
		r.Header.Set("Origin", f.server.URL)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		f.cloud.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	online := call(key)
	if online.Code != 200 || online.Body.String() != "{\"online\":true}\n" || online.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("incorrect presence response", online.Code, online.Body.String())
	}
	f.cloud.mu.Lock()
	peers, starts := len(f.cloud.roomPeers), f.cloud.roomHosts[key].joins.starts
	connections, unauth := f.cloud.connections, f.cloud.unauthenticated
	f.cloud.mu.Unlock()
	if peers != 0 || starts != 0 || connections != 1 || unauth != 0 {
		t.Fatal("presence check allocated a guest or consumed join budget")
	}
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	unknown := call(roomKeyID(other))
	f.agent.Close()
	eventually(t, func() bool { f.cloud.mu.Lock(); defer f.cloud.mu.Unlock(); return f.cloud.roomHosts[key] == nil })
	offline := call(key)
	if offline.Code != 200 || offline.Body.String() != "{\"online\":false}\n" || unknown.Body.String() != offline.Body.String() {
		t.Fatal("offline and unknown rooms should not leak historical registration")
	}
}

func TestRoomStatusValidatesOriginBodyAndServiceHealth(t *testing.T) {
	f := roomFixture(t, false)
	key, _ := f.agent.room.snapshot()
	call := func(body string, change func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", f.server.URL+"/api/room/status", strings.NewReader(body))
		r.Header.Set("Origin", f.server.URL)
		r.Header.Set("Content-Type", "application/json")
		if change != nil {
			change(r)
		}
		w := httptest.NewRecorder()
		f.cloud.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	body := `{"roomKey":"` + key + `"}`
	for _, tc := range []struct {
		change func(*http.Request)
		status int
	}{
		{func(r *http.Request) { r.Header.Del("Origin") }, 403},
		{func(r *http.Request) { r.Header.Set("Origin", "https://evil.invalid") }, 403},
		{func(r *http.Request) { r.Header.Set("Authorization", "Bearer ignored") }, 403},
		{func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{func(r *http.Request) { r.Method = "GET" }, 405},
		{func(r *http.Request) { r.URL.RawQuery = "roomKey=not-in-URL" }, 400},
	} {
		if w := call(body, tc.change); w.Code != tc.status {
			t.Fatal("invalid request accepted", w.Code, tc.status)
		}
	}
	for _, invalid := range []string{`{}`, `{"roomKey":"bad"}`, `{"roomKey":"` + key + `","password":"not-accepted"}`, `{"roomKey":"` + key + `","roomKey":"` + key + `"}`} {
		if w := call(invalid, nil); w.Code != 400 {
			t.Fatal("invalid body accepted", w.Code)
		}
	}
	if w := call(strings.Repeat("x", 1025), nil); w.Code != 413 {
		t.Fatal("unbounded body")
	}
	f.cloud.mu.Lock()
	f.cloud.unauthenticated = 64
	f.cloud.mu.Unlock()
	w := call(body, nil)
	f.cloud.mu.Lock()
	f.cloud.unauthenticated = 0
	f.cloud.healthy = false
	f.cloud.mu.Unlock()
	if w.Code != 503 {
		t.Fatal("admission limit ignored")
	}
	w = call(body, nil)
	f.cloud.mu.Lock()
	f.cloud.healthy = true
	f.cloud.mu.Unlock()
	if w.Code != 503 || strings.Contains(w.Body.String(), "online") {
		t.Fatal("service failure reported as room offline")
	}
}
