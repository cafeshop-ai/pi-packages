package collaboration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/agentdist"
)

func agentStore(t *testing.T, files map[string][]byte) (*Store, *agentdist.Bundle) {
	t.Helper()
	entries := []any{}
	for _, name := range []string{agentdist.Listener, agentdist.PiBridge} {
		if body, ok := files[name]; ok {
			sum := sha256.Sum256(body)
			e := map[string]any{"name": name, "bytes": len(body), "sha256": hex.EncodeToString(sum[:])}
			if name == agentdist.Listener {
				e["protocol"] = "1.1"
			}
			entries = append(entries, e)
		}
	}
	manifest, _ := json.Marshal(map[string]any{"format": "pi-cafe-space-agent-v2", "version": "0.1.0", "files": entries})
	bundle, err := agentdist.Load(manifest, func(name string) ([]byte, error) {
		if body, ok := files[name]; ok {
			return body, nil
		}
		return nil, errors.New("missing")
	})
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(t.TempDir(), "private"), testOrigin, Options{Agent: bundle})
	if err != nil {
		t.Fatal(err)
	}
	return s, bundle
}

var bothFiles = map[string][]byte{agentdist.Listener: []byte("#!/usr/bin/env node\n// space-agent bundle\n"), agentdist.PiBridge: []byte("export default function () {}\n")}

func get(s *Store, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestTheServerOffersTheFilesTheGuideNames(t *testing.T) {
	s, b := agentStore(t, bothFiles)
	for _, name := range []string{agentdist.Listener, agentdist.PiBridge} {
		f := b.Get(name)
		w := get(s, "GET", endpoint+"/agent/"+name)
		if w.Code != 200 || w.Body.String() != string(f.Body) || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") || w.Header().Get("X-Content-SHA256") != f.SHA256 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s download: %d %q %v", name, w.Code, w.Body.String(), w.Header())
		}
		if head := get(s, "HEAD", endpoint+"/agent/"+name); head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(len(f.Body)) {
			t.Fatalf("%s HEAD: %d %d %v", name, head.Code, head.Body.Len(), head.Header())
		}
	}
	if post := get(s, "POST", endpoint+"/agent/"+agentdist.Listener); post.Code != 405 {
		t.Fatalf("POST: %d", post.Code)
	}
	for _, path := range []string{"/agent/other.mjs", "/agent/", "/agent/sub/" + agentdist.Listener} {
		if w := get(s, "GET", endpoint+path); w.Code != 404 || !strings.Contains(w.Body.String(), "AGENT_FILE_UNAVAILABLE") {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if query := get(s, "GET", endpoint+"/agent/"+agentdist.Listener+"?v=1"); query.Code != 400 {
		t.Fatalf("a query string: %d", query.Code)
	}
	guide := get(s, "GET", endpoint+"/guide").Body.String()
	for _, want := range []string{
		testOrigin + endpoint + "/agent/space-agent.mjs", "SHA-256 " + b.Get(agentdist.Listener).SHA256, "Version 0.1.0", "listener protocol 1.1",
		"explicitly allowed downloading and running it", "standard input, never as an argument", "it never wakes your session by itself",
		testOrigin + endpoint + "/agent/cafe-room.js", "SHA-256 " + b.Get(agentdist.PiBridge).SHA256, "~/.pi/agent/extensions/cafe-room.js",
		"/reload", "keeps the conversation", "/cafe collab migrate --consumed-through", "a listen process or polling never wakes Pi",
	} {
		if !strings.Contains(guide, want) {
			t.Errorf("the guide does not say %q", want)
		}
	}
	features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any)
	if !slices.Contains(features, any("listener")) || !slices.Contains(features, any("pi-bridge")) {
		t.Fatalf("status features %v", features)
	}
}

func TestAListenerWithoutABridgeStillGuidesPi(t *testing.T) {
	s, _ := agentStore(t, map[string][]byte{agentdist.Listener: bothFiles[agentdist.Listener]})
	if w := get(s, "GET", endpoint+"/agent/"+agentdist.PiBridge); w.Code != 404 {
		t.Fatalf("bridge without a bundle: %d", w.Code)
	}
	guide := get(s, "GET", endpoint+"/guide").Body.String()
	if strings.Contains(guide, "cafe-room.js") || !strings.Contains(guide, "/cafe collab migrate --consumed-through") {
		t.Fatal("the guide must keep the migrate line and offer no bridge it lacks")
	}
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); !slices.Contains(features, any("listener")) || slices.Contains(features, any("pi-bridge")) {
		t.Fatalf("status features %v", features)
	}
}

func TestWithoutABundleThereAreNoAgentFiles(t *testing.T) {
	s := store(t)
	for _, name := range []string{agentdist.Listener, agentdist.PiBridge} {
		if w := get(s, "GET", endpoint+"/agent/"+name); w.Code != 404 || !strings.Contains(w.Body.String(), "AGENT_FILE_UNAVAILABLE") {
			t.Fatalf("%s without a bundle: %d %s", name, w.Code, w.Body.String())
		}
	}
	if guide := get(s, "GET", endpoint+"/guide").Body.String(); strings.Contains(guide, "Official listener") || strings.Contains(guide, "cafe-room.js") {
		t.Fatal("the guide offers files the server does not have")
	}
	features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any)
	if slices.Contains(features, any("listener")) || slices.Contains(features, any("pi-bridge")) {
		t.Fatal("status reports files the server does not have")
	}
	// Reporting them never changes the shared feature list.
	agentStore(t, bothFiles)
	if slices.Contains(features, "listener") || slices.Contains(features, "pi-bridge") {
		t.Fatal("the package feature list was modified")
	}
}
