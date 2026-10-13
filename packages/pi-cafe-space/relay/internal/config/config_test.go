package config

import (
	"strings"
	"testing"
)

func TestDefaultsAndNoEnvMutation(t *testing.T) {
	env := map[string]string{}
	c, e := Parse(env)
	if e != nil {
		t.Fatal(e)
	}
	if c.Host != "127.0.0.1" || c.Port != 37891 || c.HostToken != "local-dev-host-token" || c.ClientToken != "local-dev-client-token" || !c.DevelopmentCredentials {
		t.Fatalf("bad defaults %+v", c)
	}
	if len(env) != 0 {
		t.Fatal("mutated env")
	}
}
func TestConfigBounds(t *testing.T) {
	for _, tc := range []struct {
		name, key, value string
		valid            bool
	}{
		{"port-zero", "PI_COLLAB_PORT", "0", false}, {"port-65535", "PI_COLLAB_PORT", "65535", true}, {"port-overflow", "PI_COLLAB_PORT", "65536", false},
		{"port-empty", "PI_COLLAB_PORT", "  ", true}, {"port-plus", "PI_COLLAB_PORT", "+1", false}, {"port-exp", "PI_COLLAB_PORT", "1e3", false}, {"port-hex", "PI_COLLAB_PORT", "0x10", false},
		{"port-raw-bound", "PI_COLLAB_PORT", strings.Repeat(" ", 17), false}, {"port-leading-zeros", "PI_COLLAB_PORT", "00000123", true},
		{"host-bound", "PI_COLLAB_HOST", strings.Repeat(" ", 256), false}, {"token-bound", "PI_COLLAB_HOST_TOKEN", strings.Repeat(" ", 4097), false},
		{"origins-raw-bound", "PI_COLLAB_ALLOWED_ORIGINS", strings.Repeat(",", 64*2049+1), false},
		{"origins-count", "PI_COLLAB_ALLOWED_ORIGINS", strings.Repeat("http://example.test,", 65), false},
		{"origins-empty-items", "PI_COLLAB_ALLOWED_ORIGINS", ", ,http://example.test,", true},
		{"origin-credential", "PI_COLLAB_ALLOWED_ORIGINS", "https://user:pass@example.test", false},
		{"origin-path", "PI_COLLAB_ALLOWED_ORIGINS", "https://example.test/path", false},
		{"origin-query", "PI_COLLAB_ALLOWED_ORIGINS", "https://example.test?", false}, {"origin-fragment", "PI_COLLAB_ALLOWED_ORIGINS", "https://example.test#", false},
		{"origin-protocol", "PI_COLLAB_ALLOWED_ORIGINS", "file:///tmp", false}, {"origin-relative", "PI_COLLAB_ALLOWED_ORIGINS", "//example.test", false},
		{"origin-port", "PI_COLLAB_ALLOWED_ORIGINS", "http://example.test:99999", false},
		{"token-js-trim", "PI_COLLAB_HOST_TOKEN", "\ufefftoken\u00a0", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(map[string]string{tc.key: tc.value})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
			if err != nil && strings.Contains(err.Error(), "user:pass") {
				t.Fatal("credential leaked")
			}
		})
	}
}
func TestRemoteTokensAndLoopback(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"} {
		if _, e := Parse(map[string]string{"PI_COLLAB_HOST": host}); e != nil {
			t.Fatalf("%s: %v", host, e)
		}
	}
	for _, host := range []string{"0.0.0.0", "::", "127.0.0.2", "example.test"} {
		if _, e := Parse(map[string]string{"PI_COLLAB_HOST": host}); e == nil {
			t.Fatalf("accepted default credentials on %s", host)
		}
		env := map[string]string{"PI_COLLAB_HOST": host, "PI_COLLAB_HOST_TOKEN": "v7Q2mN9#pL4zR8!x", "PI_COLLAB_CLIENT_TOKEN": "q6!L9x3@K8z2#R7v"}
		if _, e := Parse(env); e != nil {
			t.Fatal(e)
		}
		env["PI_COLLAB_CLIENT_TOKEN"] = strings.ToUpper(env["PI_COLLAB_HOST_TOKEN"])
		if _, e := Parse(env); e == nil {
			t.Fatal("accepted case-equivalent secrets")
		}
	}
	for _, s := range []string{"aaaaaaaaaaaaaaaa", "aaaaaaBCDEFGHIJKLMN", "abcdefghijklmnop", "passwordpassword", "aaaaabbbbbcccccdddddeeeeefffff", "replace-with-a-long-random-token", "LOCAL-DEV-HOST-TOKEN"} {
		_, e := Parse(map[string]string{"PI_COLLAB_HOST": "0.0.0.0", "PI_COLLAB_HOST_TOKEN": s, "PI_COLLAB_CLIENT_TOKEN": "q6!L9x3@K8z2#R7v"})
		if e == nil {
			t.Fatalf("accepted weak/default token")
		}
	}
}
