package httpserver

import (
	"context"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/webui"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestHTTPPolicy(t *testing.T) {
	assets, e := webui.Load(fstest.MapFS{"index.html": {Data: []byte("<html>fixture</html>")}, "assets/a.js": {Data: []byte("export {};")}}, []string{"index.html", "assets/a.js"})
	if e != nil {
		t.Fatal(e)
	}
	h := NewHandler(assets)
	for _, tc := range []struct {
		method, path string
		status       int
		body         string
	}{
		{"GET", "/healthz", 200, `{"ok":true,"protocolVersion":1}`}, {"HEAD", "/healthz", 200, ""},
		{"GET", "/api/config", 200, `{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main"}`}, {"HEAD", "/", 200, ""},
		{"GET", "/", 200, "<html>fixture</html>"}, {"GET", "/assets/a.js", 200, "export {};"},
		{"POST", "/healthz", 405, ""}, {"POST", "/missing", 405, ""},
		{"GET", "/ws/", 404, "Not found"}, {"GET", "/HEALTHZ", 404, "Not found"},
		{"GET", "/assets/../index.html", 404, "Not found"}, {"GET", "/%69ndex.html", 404, "Not found"},
		{"GET", "//index.html", 404, "Not found"}, {"GET", "/assets/a.js.map", 404, "Not found"},
		{"GET", "/.env", 404, "Not found"}, {"GET", "/unknown", 404, "Not found"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || w.Body.String() != tc.body {
				t.Fatalf("status %d body %q", w.Code, w.Body.String())
			}
			for k, v := range securityHeaders {
				if w.Header().Get(k) != v {
					t.Errorf("missing %s", k)
				}
			}
			if w.Header().Get("Location") != "" {
				t.Fatal("unexpected redirect")
			}
			if tc.status == 405 && w.Header().Get("Allow") != "GET, HEAD" {
				t.Fatal("Allow missing")
			}
		})
	}
	w := httptest.NewRecorder()
	NewHandler(nil).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "not built") {
		t.Fatal("stub masquerades as web")
	}
	r := httptest.NewRequest("GET", "/healthz", strings.NewReader("body"))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 || w.Header().Get("Connection") != "close" {
		t.Fatal("body admission")
	}
}
func TestListenerLifecycleAndLimits(t *testing.T) {
	server := NewServer(NewHandler(nil))
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ln) }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if e := server.Shutdown(ctx); e != nil {
			t.Error(e)
		}
		if e := <-done; e != http.ErrServerClosed {
			t.Error(e)
		}
	}()
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	response, e := client.Get("http://" + ln.Addr().String() + "/healthz")
	if e != nil {
		t.Fatal(e)
	}
	b, e := io.ReadAll(response.Body)
	response.Body.Close()
	if e != nil || response.StatusCode != 200 || !strings.Contains(string(b), "protocolVersion") {
		t.Fatal("health request failed")
	}
	request, e := http.NewRequest("GET", "http://"+ln.Addr().String()+"/healthz", nil)
	if e != nil {
		t.Fatal(e)
	}
	request.Header.Set("X-Oversized", strings.Repeat("x", 32*1024))
	response, e = client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 431 {
		t.Fatalf("oversized headers: %d", response.StatusCode)
	}
	if server.ReadHeaderTimeout != 10*time.Second || server.ReadTimeout != 30*time.Second || server.IdleTimeout != 5*time.Second || server.WriteTimeout != 5*time.Second {
		t.Fatal("timeout limits missing")
	}
}
