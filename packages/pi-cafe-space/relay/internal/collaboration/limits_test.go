package collaboration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"testing"
	"time"
)

func limited(t *testing.T, options Options) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "private"), testOrigin, options)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// from sends q as if it arrived from remote, optionally carrying a CF-Connecting-IP header.
func from(t *testing.T, s *Store, remote, client string, q map[string]any, status int) map[string]any {
	t.Helper()
	b, _ := json.Marshal(q)
	r := httptest.NewRequest("POST", endpoint, bytes.NewReader(b))
	r.RemoteAddr = remote
	r.Header.Set("Content-Type", "application/json")
	if client != "" {
		r.Header.Set("CF-Connecting-IP", client)
	}
	w := httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%v from %s/%s: status=%d body=%s", q["op"], remote, client, w.Code, w.Body.String())
	}
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return result
}

var createRoom = map[string]any{"op": "create", "title": "配额测试", "name": "Owner", "kind": "human"}

func TestTrustedProxyClientsGetTheirOwnAnonymousQuota(t *testing.T) {
	s := limited(t, Options{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("192.168.48.1/32")}, ClientIPHeader: "CF-Connecting-IP"})
	const proxy = "192.168.48.1:40000"
	for i := 0; i < 5; i++ {
		from(t, s, proxy, "203.0.113.10", createRoom, 200)
	}
	from(t, s, proxy, "203.0.113.10", createRoom, 429)
	// Another visitor behind the same proxy is not blocked by the first one.
	from(t, s, proxy, "2001:db8::7", createRoom, 200)
	// An untrusted peer cannot pick its bucket with the header.
	for i := 0; i < 5; i++ {
		from(t, s, "198.51.100.7:4000", fmt.Sprintf("203.0.113.%d", 50+i), createRoom, 200)
	}
	from(t, s, "198.51.100.7:4000", "203.0.113.99", createRoom, 429)
	// A missing or malformed header from the proxy falls back to the proxy's own bucket.
	for i := 0; i < 5; i++ {
		from(t, s, proxy, "", createRoom, 200)
	}
	from(t, s, proxy, "not-an-address", createRoom, 429)
}

func TestGlobalCeilingsBoundSpoofedClients(t *testing.T) {
	s := limited(t, Options{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("192.168.48.1/32")}, ClientIPHeader: "CF-Connecting-IP"})
	for i := 0; i < 60; i++ {
		from(t, s, "192.168.48.1:40000", fmt.Sprintf("203.0.113.%d", i), createRoom, 200)
	}
	from(t, s, "192.168.48.1:40000", "198.51.100.200", createRoom, 429)
}

func TestRoomLimitAndRetentionFollowOptions(t *testing.T) {
	s := limited(t, Options{MaxRooms: 2, RetentionDays: 30})
	if call(t, s, map[string]any{"op": "status"}, "", 200)["retentionDays"].(float64) != 30 {
		t.Fatal("status must report the configured retention")
	}
	first := call(t, s, createRoom, "", 200)
	call(t, s, createRoom, "", 200)
	call(t, s, createRoom, "", 409)
	view := call(t, s, map[string]any{"op": "read", "roomId": first["roomId"]}, first["token"].(string), 200)
	expires, _ := time.Parse(time.RFC3339Nano, view["expires"].(string))
	if d := time.Until(expires); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Fatalf("room should expire after the configured retention, got %v", d)
	}
	// Lowering the limits later never prevents existing rooms from loading.
	lowered, err := New(s.directory, testOrigin, Options{MaxRooms: 1, MaxStoreBytes: 1})
	if err != nil {
		t.Fatalf("existing rooms must still load under lower limits: %v", err)
	}
	call(t, lowered, map[string]any{"op": "read", "roomId": first["roomId"]}, first["token"].(string), 200)
	call(t, lowered, createRoom, "", 409)
	call(t, lowered, map[string]any{"op": "send", "roomId": first["roomId"], "id": "over-the-store", "text": "x"}, first["token"].(string), 507)
}
