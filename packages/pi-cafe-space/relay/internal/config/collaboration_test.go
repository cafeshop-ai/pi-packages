package config

import (
	"path/filepath"
	"testing"
)

func TestCollaborationRequiresExplicitDurableRemoteState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "collaboration")
	valid := map[string]string{"PI_CAFE_COLLAB_DIRECTORY": path, "PI_CAFE_REMOTE_CONFIG": filepath.Join(t.TempDir(), "cloud.json")}
	cfg, err := Parse(valid)
	if err != nil || cfg.CollaborationDirectory != path {
		t.Fatalf("valid config: %v", err)
	}
	if l := cfg.Collaboration; l.MaxRooms != 1024 || l.RetentionDays != 7 || l.MaxStoreMB != 64 || l.ClientIPHeader != "" || len(l.TrustedProxies) != 0 {
		t.Fatalf("unexpected collaboration defaults: %+v", l)
	}
	tuned := map[string]string{"PI_CAFE_COLLAB_MAX_ROOMS": "4096", "PI_CAFE_COLLAB_RETENTION_DAYS": "30", "PI_CAFE_COLLAB_MAX_STORE_MB": "256", "PI_CAFE_COLLAB_TRUSTED_PROXIES": "192.168.48.1, ::1/128", "PI_CAFE_COLLAB_CLIENT_IP_HEADER": "CF-Connecting-IP"}
	for k, v := range valid {
		tuned[k] = v
	}
	if cfg, err = Parse(tuned); err != nil || cfg.Collaboration.MaxRooms != 4096 || cfg.Collaboration.RetentionDays != 30 || cfg.Collaboration.MaxStoreMB != 256 || len(cfg.Collaboration.TrustedProxies) != 2 || cfg.Collaboration.TrustedProxies[0].String() != "192.168.48.1/32" || cfg.Collaboration.ClientIPHeader != "CF-Connecting-IP" {
		t.Fatalf("tuned limits: %+v %v", cfg.Collaboration, err)
	}
	for _, bad := range []map[string]string{
		{"PI_CAFE_COLLAB_MAX_ROOMS": "0"}, {"PI_CAFE_COLLAB_RETENTION_DAYS": "366"}, {"PI_CAFE_COLLAB_MAX_STORE_MB": "+5"},
		{"PI_CAFE_COLLAB_TRUSTED_PROXIES": "proxy.example"}, {"PI_CAFE_COLLAB_CLIENT_IP_HEADER": "CF-Connecting-IP"},
		{"PI_CAFE_COLLAB_TRUSTED_PROXIES": "127.0.0.1"}, {"PI_CAFE_COLLAB_TRUSTED_PROXIES": "127.0.0.1", "PI_CAFE_COLLAB_CLIENT_IP_HEADER": "Bad Header"},
	} {
		for k, v := range valid {
			bad[k] = v
		}
		if _, err := Parse(bad); err == nil {
			t.Fatalf("accepted invalid collaboration limits: %v", bad)
		}
	}
	if _, err := Parse(map[string]string{"PI_CAFE_COLLAB_MAX_ROOMS": "10"}); err == nil {
		t.Fatal("collaboration limits without a collaboration directory must be rejected")
	}
	for _, env := range []map[string]string{
		{"PI_CAFE_COLLAB_DIRECTORY": "relative", "PI_CAFE_REMOTE_CONFIG": "cloud.json"},
		{"PI_CAFE_COLLAB_DIRECTORY": path},
		{"PI_CAFE_COLLAB_DIRECTORY": path, "PI_CAFE_CREDENTIALS_FILE": filepath.Join(t.TempDir(), "credentials.json")},
	} {
		if _, err := Parse(env); err == nil {
			t.Fatal("accepted unsafe collaboration state")
		}
	}
}
