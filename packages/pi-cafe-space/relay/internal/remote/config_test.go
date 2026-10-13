package remote

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testUserToken = "V8Znbfj2dR5Nq6TQAzS4EYhuMwK9gDreBpL3CFxtsa0"
const testDeviceToken = "hRp2Mza9NYVq0WfBT4sjDUKx35AEe7bcGFy6ZnL8QIo"

func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func cloudConfig() Config {
	return Config{Mode: "cloud", PublicOrigin: "http://127.0.0.1:37994", Devices: []Device{{ID: "office", Name: "Office", TokenHash: digest(testDeviceToken)}}, Users: []User{{ID: "alice", Name: "Alice", TokenHash: digest(testUserToken), Grants: []Grant{{DeviceID: "office", Room: "main", Role: "admin"}}}}}
}
func TestConfigAndLeastPrivilege(t *testing.T) {
	c := cloudConfig()
	if err := c.Validate(); err != nil { t.Fatal(err) }
	u, ok := c.AuthenticateUser(testUserToken)
	if !ok || u.ID != "alice" { t.Fatal("valid identity rejected") }
	if _, ok := c.AuthenticateUser(testUserToken + "x"); ok { t.Fatal("wrong token accepted") }
	if _, ok := c.AuthenticateUser(testDeviceToken); ok { t.Fatal("device token became a user") }
	if role, ok := u.RoleFor("office", "main"); !ok || role != "admin" { t.Fatal("grant missing") }
	for _, pair := range [][2]string{{"office", "private"}, {"other", "main"}} {
		if _, ok := u.RoleFor(pair[0], pair[1]); ok { t.Fatal("grant crossed device/room") }
	}
	c.Users[0].Disabled = true
	if _, ok := c.AuthenticateUser(testUserToken); ok { t.Fatal("revoked user accepted") }
}
func TestInvalidRemoteConfiguration(t *testing.T) {
	cases := map[string]func(*Config){
		"public plaintext": func(c *Config) { c.PublicOrigin = "http://example.com" },
		"origin path": func(c *Config) { c.PublicOrigin = "https://example.com/path" },
		"origin credentials": func(c *Config) { c.PublicOrigin = "https://user:pass@example.com" },
		"unknown device": func(c *Config) { c.Users[0].Grants[0].DeviceID = "missing" },
		"wildcard room": func(c *Config) { c.Users[0].Grants[0].Room = "*" },
		"invalid role": func(c *Config) { c.Users[0].Grants[0].Role = "root" },
		"same credential": func(c *Config) { c.Users[0].TokenHash = c.Devices[0].TokenHash },
		"duplicate device": func(c *Config) { c.Devices = append(c.Devices, c.Devices[0]) },
		"duplicate user": func(c *Config) { c.Users = append(c.Users, c.Users[0]) },
	}
	for name, mutate := range cases { t.Run(name, func(t *testing.T) { c := cloudConfig(); mutate(&c); if c.Validate() == nil { t.Fatal("invalid config accepted") } }) }
}
func TestLoadRejectsUnknownFieldsAndLargeFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote.json")
	b, _ := json.Marshal(cloudConfig())
	if err := os.WriteFile(path, b, 0600); err != nil { t.Fatal(err) }
	if _, err := Load(path); err != nil { t.Fatal(err) }
	if err := os.WriteFile(path, append(b[:len(b)-1], []byte(",\"executeAnything\":true}")...), 0600); err != nil { t.Fatal(err) }
	if _, err := Load(path); err == nil { t.Fatal("unknown field accepted") }
	if err := os.WriteFile(path, []byte(strings.Repeat(" ", 512*1024+1)), 0600); err != nil { t.Fatal(err) }
	if _, err := Load(path); err == nil { t.Fatal("oversized config accepted") }
}
func TestTURNReservesAnICEServerSlot(t *testing.T) {
	c := cloudConfig()
	for i := 0; i < 8; i++ {
		c.ICEServers = append(c.ICEServers, ICEServer{URLs: []string{"stun:stun.example.com:3478"}})
	}
	if err := c.Validate(); err != nil { t.Fatal(err) }
	c.TURN = &TURNConfig{URLs: []string{"turn:turn.example.com:3478"}, SharedSecret: strings.Repeat("s", 32)}
	if c.Validate() == nil { t.Fatal("TURN must reserve a slot in the eight-server wire budget") }
	c.ICEServers = c.ICEServers[:7]
	cloud, err := NewCloud(c, "")
	if err != nil { t.Fatal(err) }
	defer cloud.Close()
	servers := cloud.iceServers("alice")
	if len(servers) != 8 || !((Frame{Type: "opened", ICEServers: servers}).valid()) {
		t.Fatal("accepted configuration cannot be delivered to the browser/device")
	}
}

func TestDeviceNeedsExplicitRoomsAndSecureCloud(t *testing.T) {
	c := Config{Mode: "device", DeviceID: "office", DeviceToken: testDeviceToken, CloudURL: "wss://cafe.example.com/remote/agent", Rooms: []string{"main"}, MaxRole: "admin"}
	if err := c.Validate(); err != nil { t.Fatal(err) }
	c.CloudURL = "ws://cafe.example.com/remote/agent"
	if c.Validate() == nil { t.Fatal("plaintext remote accepted") }
	c.CloudURL = "ws://127.0.0.1:37994/remote/agent"
	if err := c.Validate(); err != nil { t.Fatal(err) }
	c.Rooms = nil
	if c.Validate() == nil { t.Fatal("implicit all-room access") }
}
