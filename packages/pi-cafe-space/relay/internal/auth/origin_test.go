package auth

import (
	"crypto/tls"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestOriginPolicy(t *testing.T) {
	allowed, e := NewOrigins([]string{"https://public.example", "https://EXAMPLE.test:443/"})
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		origin, host string
		tls, ok      bool
	}{
		{"", "localhost:37891", false, true}, {"http://localhost:37891", "localhost:37891", false, true},
		{"https://localhost:37891", "localhost:37891", false, false}, {"https://localhost:37891", "localhost:37891", true, true},
		{"http://evil.test", "localhost:37891", false, false}, {"https://public.example", "localhost:37891", false, true},
		{"https://example.test", "localhost:37891", false, true}, {"null", "localhost", false, false},
		{"http://user:pass@localhost", "localhost", false, false}, {"http://localhost/path", "localhost", false, false},
		{"http://localhost?", "localhost", false, false}, {"http://localhost#", "localhost", false, false},
		{"http://127.1", "127.0.0.1", false, true}, {"http://0x7f000001", "127.0.0.1", false, true},
		{"http://[0:0:0:0:0:0:0:1]", "[::1]", false, true}, {"https://public.example/evil", "localhost", false, false},
	} {
		t.Run(tc.origin+tc.host, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://relay/ws", nil)
			r.Host = tc.host
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			r.Header.Set("X-Forwarded-Proto", "https")
			r.Header.Set("X-Forwarded-Host", "public.example")
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			if got := allowed.Allowed(r); got != tc.ok {
				t.Fatalf("allowed=%v want=%v", got, tc.ok)
			}
		})
	}
	r := httptest.NewRequest("GET", "http://relay/ws", nil)
	r.Header.Add("Origin", "http://relay")
	r.Header.Add("Origin", "http://evil")
	if allowed.Allowed(r) {
		t.Fatal("ambiguous Origin")
	}
}
func TestFrozenNodeOrigins(t *testing.T) {
	b, e := os.ReadFile("testdata/origins.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Input    string
		Expected *string
	}
	if e := json.Unmarshal(b, &cases); e != nil {
		t.Fatal(e)
	}
	for _, c := range cases {
		t.Run(c.Input, func(t *testing.T) {
			got, err := NormalizeOrigin(c.Input)
			if c.Expected == nil {
				if err == nil {
					t.Fatalf("expected rejection, got %s", got)
				}
			} else if err != nil || got != *c.Expected {
				t.Fatalf("got %q / %v; want %q", got, err, *c.Expected)
			}
		})
	}
}
func TestTokenComparison(t *testing.T) {
	if !TokenMatches("fixture", "fixture") || TokenMatches("fixture", "Fixture") || TokenMatches("fixture", "") {
		t.Fatal("token comparison")
	}
}
