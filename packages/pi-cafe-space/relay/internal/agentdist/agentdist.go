// Package agentdist holds the files the Space server offers agents same-origin: the official room
// listener (docs/LISTENER.md) and the Pi room bridge, the cafe collab extension that lets a Pi
// session be woken by room messages. The release build bundles each into one file and writes one
// manifest; the server serves the files unchanged and names their SHA-256 in the room guide, so an
// agent can check what it downloaded before running or loading it.
package agentdist

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
)

// Listener and PiBridge are the file names, and the last path segment under which each is served.
const (
	Listener = "space-agent.mjs"
	PiBridge = "cafe-room.js"
)

const manifestFormat = "pi-cafe-space-agent-v2"

// MaxBytes bounds each embedded file; the bundles are far smaller.
const MaxBytes = 2 << 20

// File is one verified bundle and what the guide says about it.
type File struct {
	Name     string
	Protocol string // the listener protocol version in docs/LISTENER.md; empty for the bridge
	SHA256   string
	Body     []byte
}

// Bundle is every file of one build, all from the same package version.
type Bundle struct {
	Version string
	files   map[string]*File
}

// Get returns the named file, or nil when this build does not carry it.
func (b *Bundle) Get(name string) *File {
	if b == nil {
		return nil
	}
	return b.files[name]
}

type manifest struct {
	Format  string `json:"format"`
	Version string `json:"version"`
	Files   []struct {
		Name     string `json:"name"`
		Protocol string `json:"protocol,omitempty"`
		Bytes    int    `json:"bytes"`
		SHA256   string `json:"sha256"`
	} `json:"files"`
}

var versionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Load checks every file against the manifest. Any mismatch is an error, never a partial bundle.
func Load(manifestJSON []byte, read func(name string) ([]byte, error)) (*Bundle, error) {
	var m manifest
	if json.Unmarshal(manifestJSON, &m) != nil || m.Format != manifestFormat || !versionPattern.MatchString(m.Version) || len(m.Files) == 0 {
		return nil, errors.New("invalid agent manifest")
	}
	b := &Bundle{Version: m.Version, files: map[string]*File{}}
	for _, f := range m.Files {
		known := f.Name == Listener && versionPattern.MatchString(f.Protocol) || f.Name == PiBridge && f.Protocol == ""
		if !known || b.files[f.Name] != nil || !hashPattern.MatchString(f.SHA256) {
			return nil, errors.New("invalid agent manifest")
		}
		body, err := read(f.Name)
		sum := sha256.Sum256(body)
		if err != nil || len(body) == 0 || len(body) > MaxBytes || len(body) != f.Bytes || hex.EncodeToString(sum[:]) != f.SHA256 {
			return nil, errors.New(f.Name + " does not match the agent manifest")
		}
		b.files[f.Name] = &File{Name: f.Name, Protocol: f.Protocol, SHA256: f.SHA256, Body: body}
	}
	return b, nil
}
