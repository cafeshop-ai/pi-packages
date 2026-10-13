// Package remote connects authenticated browsers to an explicitly configured
// office device. It never owns AgentSession, project files or provider keys.
package remote

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const MaxConfigBytes = 512 * 1024
const MaxPeers = 128
const MaxDevicePeers = 32

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)

// Access keys are generated randomly; only their SHA-256 hashes are persisted
// by the cloud. A device credential cannot authenticate a browser or vice versa.
type User struct {
	ID string `json:"id"`
	Name string `json:"name"`
	TokenHash string `json:"tokenHash"`
	Disabled bool `json:"disabled,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Grants []Grant `json:"grants"`
}
type Grant struct {
	DeviceID string `json:"deviceId"`
	Room string `json:"room"`
	Role string `json:"role"`
}
type Device struct {
	ID string `json:"id"`
	Name string `json:"name"`
	TokenHash string `json:"tokenHash"`
	Disabled bool `json:"disabled,omitempty"`
}
type ICEServer struct {
	URLs []string `json:"urls"`
	Username string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}
type TURNConfig struct {
	URLs []string `json:"urls"`
	SharedSecret string `json:"sharedSecret"`
	TTLSeconds int `json:"ttlSeconds,omitempty"`
}
type Config struct {
	AccountIssuer string `json:"accountIssuer,omitempty"`
	RoomAccess bool `json:"roomAccess,omitempty"`
	RoomIdentityFile string `json:"roomIdentityFile,omitempty"`
	RoomManagement bool `json:"roomManagement,omitempty"`
	Mode string `json:"mode"`
	PublicOrigin string `json:"publicOrigin,omitempty"`
	CloudURL string `json:"cloudUrl,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	DeviceToken string `json:"deviceToken,omitempty"`
	Rooms []string `json:"rooms,omitempty"`
	MaxRole string `json:"maxRole,omitempty"`
	EnableWebRTC bool `json:"enableWebRTC,omitempty"`
	ICEServers []ICEServer `json:"iceServers,omitempty"`
	TURN *TURNConfig `json:"turn,omitempty"`
	Users []User `json:"users,omitempty"`
	Devices []Device `json:"devices,omitempty"`
}
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil { return "", err }
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func TokenHash(token string) string { h := sha256.Sum256([]byte(token)); return hex.EncodeToString(h[:]) }
func tokenMatches(token, hash string) bool {
	if !tokenPattern.MatchString(token) || !hashPattern.MatchString(hash) { return false }
	h := TokenHash(token)
	return subtle.ConstantTimeCompare([]byte(h), []byte(hash)) == 1
}
func roleRank(role string) int {
	switch role { case "viewer": return 1; case "operator": return 2; case "admin": return 3; default: return 0 }
}
func validName(s string) bool {
	if strings.TrimSpace(s) != s || len(s) == 0 || len(s) > 128 { return false }
	for _, r := range s { if r < 32 || r == 127 { return false } }
	return true
}
func loopback(host string) bool {
	if strings.EqualFold(host, "localhost") { return true }
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func secureURL(raw, path string, websocket bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || len(raw) > 2048 { return false }
	if path == "" { if u.Path != "" && u.Path != "/" { return false } } else if u.Path != path { return false }
	secure, insecure := "https", "http"
	if websocket { secure, insecure = "wss", "ws" }
	return u.Scheme == secure || u.Scheme == insecure && loopback(u.Hostname())
}
func validateICE(servers []ICEServer) error {
	if len(servers) > 8 { return errors.New("too many ICE servers") }
	for _, s := range servers {
		if len(s.URLs) == 0 || len(s.URLs) > 4 || len(s.Username) > 256 || len(s.Credential) > 4096 { return errors.New("invalid ICE server limits") }
		for _, raw := range s.URLs {
			u, err := url.Parse(raw)
			if err != nil || len(raw) > 2048 || u.User != nil || u.Fragment != "" || !strings.Contains(raw, ":") || (u.Scheme != "stun" && u.Scheme != "stuns" && u.Scheme != "turn" && u.Scheme != "turns") { return errors.New("invalid ICE URL") }
		}
	}
	return nil
}
func (c Config) Validate() error {
	if c.AccountIssuer!="" { if c.AccountIssuer!=strings.TrimRight(c.PublicOrigin,"/")+"/api/identity" || !secureURL(c.AccountIssuer,"/api/identity",false) { return errors.New("account identity issuer must match the configured public origin") } }
	if c.RoomManagement && (c.Mode!="device" || c.RoomIdentityFile=="") { return errors.New("room process management requires explicit office room mode") }
	if err := validateICE(c.ICEServers); err != nil { return err }
	if c.TURN != nil {
		// The credentialed TURN entry is appended to the same bounded list sent
		// to both endpoints; accept only configurations that fit the wire budget.
		if len(c.ICEServers) >= 8 { return errors.New("TURN requires a reserved ICE server slot") }
		if c.Mode != "cloud" || len(c.TURN.SharedSecret) < 32 || len(c.TURN.SharedSecret) > 4096 || c.TURN.TTLSeconds < 0 || c.TURN.TTLSeconds > 3600 { return errors.New("invalid TURN secret or TTL") }
		if err := validateICE([]ICEServer{{URLs: c.TURN.URLs}}); err != nil { return err }
		for _, raw := range c.TURN.URLs { if !strings.HasPrefix(raw, "turn:") && !strings.HasPrefix(raw, "turns:") { return errors.New("TURN URLs required") } }
	}
	switch c.Mode {
	case "cloud":
		if !secureURL(c.PublicOrigin, "", false) || c.CloudURL != "" || c.DeviceToken != "" || c.DeviceID != "" || len(c.Rooms) != 0 || c.MaxRole != "" { return errors.New("invalid cloud origin or mixed device configuration") }
		if c.RoomIdentityFile!=""||c.RoomAccess&&!c.EnableWebRTC { return errors.New("public rooms require WebRTC and no local identity file") }
		if (!c.RoomAccess&&(len(c.Users)==0||len(c.Devices)==0)) || len(c.Users) > 128 || len(c.Devices) > 64 { return errors.New("explicit bounded users and devices required") }
		devices, users, hashes := map[string]bool{}, map[string]bool{}, map[string]bool{}
		for _, d := range c.Devices {
			if !identifier.MatchString(d.ID) || !validName(d.Name) || !hashPattern.MatchString(d.TokenHash) || devices[d.ID] || hashes[d.TokenHash] { return errors.New("invalid or duplicate device identity") }
			devices[d.ID], hashes[d.TokenHash] = true, true
		}
		for _, u := range c.Users {
			if !identifier.MatchString(u.ID) || !validName(u.Name) || !hashPattern.MatchString(u.TokenHash) || users[u.ID] || hashes[u.TokenHash] || len(u.Grants) == 0 || len(u.Grants) > 128 { return errors.New("invalid or duplicate user identity") }
			if u.ExpiresAt != "" { if _, err := time.Parse(time.RFC3339, u.ExpiresAt); err != nil { return errors.New("invalid user expiry") } }
			users[u.ID], hashes[u.TokenHash] = true, true
			seen := map[string]bool{}
			for _, g := range u.Grants {
				key := g.DeviceID + ":" + g.Room
				if !devices[g.DeviceID] || !identifier.MatchString(g.Room) || roleRank(g.Role) == 0 || seen[key] { return errors.New("invalid or duplicate device/room grant") }
				seen[key] = true
			}
		}
	case "device":
		if c.RoomIdentityFile!="" {
			if !filepath.IsAbs(c.RoomIdentityFile)||len(c.RoomIdentityFile)>4096||!secureURL(c.PublicOrigin,"",false)||!secureURL(c.CloudURL,"/room/host",true)||!c.EnableWebRTC||c.RoomAccess||c.DeviceToken!=""||c.DeviceID!=""||len(c.Users)!=0||len(c.Devices)!=0||len(c.Rooms)!=1||c.Rooms[0]!="main"||c.MaxRole!="operator" { return errors.New("invalid room-device configuration") }
			origin,_:=url.Parse(c.PublicOrigin);socketURL,_:=url.Parse(c.CloudURL)
			if origin.Host!=socketURL.Host||((origin.Scheme=="https")!=(socketURL.Scheme=="wss")){return errors.New("room origin and signaling endpoint differ")}
			if !validName(c.DeviceName){return errors.New("room name required")};return nil
		}
		if c.RoomAccess{return errors.New("public room catalog only belongs on the cloud")}
		if !identifier.MatchString(c.DeviceID) || !tokenPattern.MatchString(c.DeviceToken) || !secureURL(c.CloudURL, "/remote/agent", true) || c.PublicOrigin != "" || len(c.Users) != 0 || len(c.Devices) != 0 || roleRank(c.MaxRole) == 0 { return errors.New("invalid office device configuration") }
		if c.DeviceName != "" && !validName(c.DeviceName) { return errors.New("invalid device name") }
		if len(c.Rooms) == 0 || len(c.Rooms) > 64 { return errors.New("explicit bounded device rooms required") }
		seen := map[string]bool{}
		for _, room := range c.Rooms { if !identifier.MatchString(room) || seen[room] { return errors.New("invalid or duplicate device room") }; seen[room] = true }
	default:
		return errors.New("remote mode must be cloud or device")
	}
	return nil
}
func Load(path string) (Config, error) {
	var c Config
	f, err := os.Open(path)
	if err != nil { return c, err }
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxConfigBytes { return c, errors.New("invalid remote configuration file") }
	b, err := io.ReadAll(io.LimitReader(f, MaxConfigBytes+1))
	if err != nil || len(b) > MaxConfigBytes { return c, errors.New("remote configuration exceeds limit") }
	if err := strictJSON(b, &c); err != nil { return Config{}, errors.New("invalid remote configuration JSON") }
	if err := c.Validate(); err != nil { return Config{}, err }
	return c, nil
}
func strictJSON(b []byte, out any) error {
	if err := uniqueJSON(b); err != nil { return err }
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil { return err }
	if d.Decode(new(any)) != io.EOF { return errors.New("trailing JSON data") }
	return nil
}
func (c Config) AuthenticateUser(token string) (User, bool) {
	for _, u := range c.Users {
		if u.Disabled || !tokenMatches(token, u.TokenHash) { continue }
		if u.ExpiresAt != "" { expires, err := time.Parse(time.RFC3339, u.ExpiresAt); if err != nil || !time.Now().Before(expires) { return User{}, false } }
		return u, true
	}
	return User{}, false
}
func (c Config) AuthenticateDevice(id, token string) (Device, bool) {
	for _, d := range c.Devices { if d.ID == id && !d.Disabled && tokenMatches(token, d.TokenHash) { return d, true } }
	return Device{}, false
}
func (u User) RoleFor(device, room string) (string, bool) {
	for _, g := range u.Grants { if g.DeviceID == device && g.Room == room { return g.Role, true } }
	return "", false
}
func (c Config) AllowsRoom(room string) bool { for _, allowed := range c.Rooms { if room == allowed { return true } }; return false }
