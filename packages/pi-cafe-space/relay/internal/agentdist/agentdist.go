// Package agentdist holds the official room listener (docs/LISTENER.md) that the Space server
// offers same-origin. The release build bundles scripts/space-agent.mjs into one file and writes
// its manifest next to it; the server serves that file unchanged and names its SHA-256 in the
// room guide, so an agent can check what it downloaded before running it.
package agentdist

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
)

// Name is the file name and the last path segment under which the listener is served.
const Name = "space-agent.mjs"

const manifestFormat = "pi-cafe-space-agent-v1"

// MaxBytes bounds the embedded listener; the bundle is far smaller.
const MaxBytes = 1 << 20

// Listener is the verified bundle and what the guide says about it.
type Listener struct {
	Version  string // the package version of the build
	Protocol string // the listener protocol version in docs/LISTENER.md
	SHA256   string
	Body     []byte
}

type manifest struct {
	Format   string `json:"format"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	Protocol string `json:"protocol"`
	Bytes    int    `json:"bytes"`
	SHA256   string `json:"sha256"`
}

var versionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Load checks the bundle against its manifest. A mismatch is an error, never a partial listener.
func Load(body, manifestJSON []byte) (*Listener, error) {
	var m manifest
	if json.Unmarshal(manifestJSON, &m) != nil || m.Format != manifestFormat || m.Name != Name ||
		!versionPattern.MatchString(m.Version) || !versionPattern.MatchString(m.Protocol) || !hashPattern.MatchString(m.SHA256) {
		return nil, errors.New("invalid listener manifest")
	}
	sum := sha256.Sum256(body)
	if len(body) == 0 || len(body) > MaxBytes || len(body) != m.Bytes || hex.EncodeToString(sum[:]) != m.SHA256 {
		return nil, errors.New("listener does not match its manifest")
	}
	return &Listener{Version: m.Version, Protocol: m.Protocol, SHA256: m.SHA256, Body: body}, nil
}
