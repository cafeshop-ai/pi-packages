package collaboration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/agentdist"
)

func listenerStore(t *testing.T) (*Store, *agentdist.Listener) {
	t.Helper()
	body := []byte("#!/usr/bin/env node\n// space-agent bundle\n")
	sum := sha256.Sum256(body)
	manifest, _ := json.Marshal(map[string]any{"format": "pi-cafe-space-agent-v1", "name": agentdist.Name, "version": "0.1.0", "protocol": "1.1", "bytes": len(body), "sha256": hex.EncodeToString(sum[:])})
	listener, err := agentdist.Load(body, manifest)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(t.TempDir(), "private"), testOrigin, Options{Listener: listener})
	if err != nil {
		t.Fatal(err)
	}
	return s, listener
}

func get(s *Store, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestTheServerOffersTheListenerTheGuideNames(t *testing.T) {
	s, l := listenerStore(t)
	w := get(s, "GET", endpoint+"/agent/space-agent.mjs")
	if w.Code != 200 || w.Body.String() != string(l.Body) || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") || w.Header().Get("X-Content-SHA256") != l.SHA256 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("listener download: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if head := get(s, "HEAD", endpoint+"/agent/space-agent.mjs"); head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(len(l.Body)) {
		t.Fatalf("HEAD: %d %d %v", head.Code, head.Body.Len(), head.Header())
	}
	if post := get(s, "POST", endpoint+"/agent/space-agent.mjs"); post.Code != 405 {
		t.Fatalf("POST: %d", post.Code)
	}
	if other := get(s, "GET", endpoint+"/agent/other.mjs"); other.Code != 404 {
		t.Fatalf("an unknown file: %d", other.Code)
	}
	if query := get(s, "GET", endpoint+"/agent/space-agent.mjs?v=1"); query.Code != 400 {
		t.Fatalf("a query string: %d", query.Code)
	}
	guide := get(s, "GET", endpoint+"/guide").Body.String()
	for _, want := range []string{testOrigin + endpoint + "/agent/space-agent.mjs", "SHA-256 " + l.SHA256, "Version 0.1.0", "listener protocol 1.1", "explicitly allowed downloading and running it", "standard input, never as an argument", "it never wakes your session by itself", "/cafe collab migrate --consumed-through"} {
		if !strings.Contains(guide, want) {
			t.Errorf("the guide does not say %q", want)
		}
	}
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); !slices.Contains(features, any("listener")) {
		t.Fatalf("status features %v lack listener", features)
	}
}

func TestWithoutABundleThereIsNoListener(t *testing.T) {
	s := store(t)
	if w := get(s, "GET", endpoint+"/agent/space-agent.mjs"); w.Code != 404 || !strings.Contains(w.Body.String(), "LISTENER_UNAVAILABLE") {
		t.Fatalf("download without a bundle: %d %s", w.Code, w.Body.String())
	}
	if guide := get(s, "GET", endpoint+"/guide").Body.String(); strings.Contains(guide, "Official listener") {
		t.Fatal("the guide offers a listener the server does not have")
	}
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); slices.Contains(features, any("listener")) {
		t.Fatal("status reports a listener the server does not have")
	}
	// Reporting the listener never changes the shared feature list.
	listenerStore(t)
	if slices.Contains(features, "listener") {
		t.Fatal("the package feature list was modified")
	}
}
