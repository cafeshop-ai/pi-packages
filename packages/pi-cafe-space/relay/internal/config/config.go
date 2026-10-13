// Package config parses explicit inputs, without reading process environment,
// opening listeners, logging credentials, or searching user configuration files.
package config

import (
	"errors"
	"encoding/base64"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Config struct {
	CredentialsFile        string
	RemoteConfig           string
	ManagedConfig          string
	// Service must verify room mode before accepting user-chosen local tokens.
	ManagedRoomCredentials bool
	Host                   string
	Port                   int
	HostToken, ClientToken string
	// Origins remain explicit entries; the HTTP auth layer owns normalization.
	AllowedOrigins         []string
	DevelopmentCredentials bool
}

const defaultHostToken = "local-dev-host-token"
const defaultClientToken = "local-dev-client-token"

var decimal = regexp.MustCompile(`^[0-9]+$`)
var placeholder = regexp.MustCompile(`(?i)^replace-with-(?:(?:a-long-random-)?(?:host|client)|a-long-random|random)-token$`)

func length(s string) int { return len(utf16.Encode([]rune(s))) }

// ECMAScript trim set, not Unicode White_Space (U+0085 is not JS whitespace).
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == 0x9 || r == 0xa || r == 0xb || r == 0xc || r == 0xd || r == 0x20 || r == 0xa0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
func fallback(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
func Parse(env map[string]string) (Config, error) {
	var c Config
	for _, f := range []struct {
		key string
		max int
	}{{"PI_COLLAB_HOST", 255}, {"PI_COLLAB_PORT", 16}, {"PI_COLLAB_HOST_TOKEN", 4096}, {"PI_COLLAB_CLIENT_TOKEN", 4096}, {"PI_COLLAB_ALLOWED_ORIGINS", 64 * 2049}} {
		if length(env[f.key]) > f.max {
			return c, errors.New(f.key + " exceeds its raw length limit")
		}
	}
	c.Host = fallback(trim(env["PI_COLLAB_HOST"]), "127.0.0.1")
	c.Host = strings.TrimPrefix(c.Host, "[")
	c.Host = strings.TrimSuffix(c.Host, "]")
	if c.Host == "" {
		return Config{}, errors.New("Relay host must not be empty")
	}
	c.Port = 37891
	port := trim(env["PI_COLLAB_PORT"])
	if port != "" {
		n, e := strconv.ParseUint(port, 10, 16)
		if !decimal.MatchString(port) || e != nil || n == 0 {
			return Config{}, errors.New("PI_COLLAB_PORT must be a valid TCP port")
		}
		c.Port = int(n)
	}
	ht, ct := trim(env["PI_COLLAB_HOST_TOKEN"]), trim(env["PI_COLLAB_CLIENT_TOKEN"])
	c.HostToken = fallback(ht, defaultHostToken)
	c.ClientToken = fallback(ct, defaultClientToken)
	host := strings.ToLower(c.Host)
	loopback := host == "127.0.0.1" || host == "localhost" || host == "::1"
	defaultToken := func(s string) bool { s = strings.ToLower(s); return s == defaultHostToken || s == defaultClientToken }
	if !loopback && (ht == "" || ct == "" || strings.EqualFold(ht, ct) || defaultToken(ht) || defaultToken(ct) || placeholder.MatchString(ht) || placeholder.MatchString(ct) || !sufficientEntropy(ht) || !sufficientEntropy(ct)) {
		return Config{}, errors.New("Explicit distinct high-entropy non-default tokens are required outside loopback mode")
	}
	c.CredentialsFile = env["PI_CAFE_CREDENTIALS_FILE"]
	if c.CredentialsFile != "" && (len(c.CredentialsFile) > 4096 || strings.ContainsRune(c.CredentialsFile, 0) || !filepath.IsAbs(c.CredentialsFile) || !loopback || env["PI_CAFE_REMOTE_CONFIG"] != "" || env["PI_COLLAB_MANAGED_CONFIG"] != "" || (ht != "" && ht != defaultHostToken) || (ct != "" && ct != defaultClientToken)) {
		return Config{}, errors.New("Local setup requires loopback, an absolute credential path and no explicit custom/remote/managed configuration")
	}
	c.RemoteConfig = env["PI_CAFE_REMOTE_CONFIG"]
	if len(c.RemoteConfig) > 4096 || strings.ContainsRune(c.RemoteConfig, 0) {
		return Config{}, errors.New("Invalid remote configuration path")
	}
	c.ManagedConfig = env["PI_COLLAB_MANAGED_CONFIG"]
	if len(c.ManagedConfig) > 4096 || strings.ContainsRune(c.ManagedConfig, 0) {
		return Config{}, errors.New("Invalid managed configuration path")
	}
	if c.ManagedConfig != "" {
		commonSafe := loopback && ht != "" && ct != "" && !strings.EqualFold(ht,ct) && !defaultToken(ht) && !defaultToken(ct) && !placeholder.MatchString(ht) && !placeholder.MatchString(ct) && sufficientEntropy(ht)
		roomSetup := commonSafe && ValidSetupHostToken(ht) && ValidStoredSetupToken(ct) && filepath.IsAbs(c.RemoteConfig)
		if !commonSafe || (!sufficientEntropy(ct) && !roomSetup) { return Config{}, errors.New("Managed Pi requires loopback and distinct explicit credentials; user-chosen tokens require verified room mode") }
		c.ManagedRoomCredentials = !sufficientEntropy(ct)
	}
	c.DevelopmentCredentials = loopback && (ht == "" || ct == "")
	c.AllowedOrigins = []string{}
	for _, raw := range strings.Split(env["PI_COLLAB_ALLOWED_ORIGINS"], ",") {
		origin := trim(raw)
		if origin == "" {
			continue
		}
		if len(c.AllowedOrigins) >= 64 || length(origin) > 2048 || !validOrigin(origin) {
			return Config{}, errors.New("PI_COLLAB_ALLOWED_ORIGINS must contain at most 64 bounded http(s) origins")
		}
		c.AllowedOrigins = append(c.AllowedOrigins, origin)
	}
	return c, nil
}
// Local users choose their own access token; there is no complexity policy.
// These bounds keep one-line input and transport handling predictable.
func ValidSetupToken(s string) bool {
	return length(s) <= 20 && ValidStoredSetupToken(s)
}

// Never invalidate or silently replace credentials already saved by older versions.
func ValidStoredSetupToken(s string) bool {
	if length(s) < 6 || length(s) > 256 || trim(s) != s { return false }
	for _, r := range s { if r < 32 || r >= 127 && r <= 159 { return false } }
	return true
}

// Internal Pi credentials are generated separately, never chosen in the form.
func ValidSetupHostToken(s string) bool {
	if len(s) != 43 { return false }
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return err == nil && len(b) == 32
}

func NeedsLocalSetup(c Config) bool {
	return c.RemoteConfig == "" && c.ManagedConfig == "" && c.HostToken == defaultHostToken && c.ClientToken == defaultClientToken
}

func validOrigin(s string) bool {
	// Share the source-derived URL policy with HTTP admission. This is pure
	// validation, not a listener/network side effect.
	_, err := auth.NormalizeOrigin(s)
	return err == nil
}
func sufficientEntropy(s string) bool {
	if length(s) > 4096 {
		return false
	}
	chars := []rune(s)
	n := len(chars)
	if n < 16 {
		return false
	}
	counts := map[rune]int{}
	for _, r := range chars {
		counts[r]++
	}
	if len(counts) < 8 {
		return false
	}
	for period := 1; period <= 8 && period <= n/2; period++ {
		repeated := true
		for i := period; i < n; i++ {
			if chars[i] != chars[i%period] {
				repeated = false
				break
			}
		}
		if repeated {
			return false
		}
	}
	step := chars[1] - chars[0]
	sequential := step == 1 || step == -1
	for i, r := range chars {
		if r > 127 || (i > 0 && r-chars[i-1] != step) {
			sequential = false
			break
		}
	}
	if sequential {
		return false
	}
	entropy := 0.0
	for _, count := range counts {
		if count*4 > n {
			return false
		}
		p := float64(count) / float64(n)
		entropy -= p * math.Log2(p)
	}
	return entropy >= 3 && entropy*float64(n) >= 64
}
