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
