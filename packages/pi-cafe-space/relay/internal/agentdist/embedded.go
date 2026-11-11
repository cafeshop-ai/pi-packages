//go:build webembed

package agentdist

import _ "embed"

//go:embed space-agent.mjs
var body []byte

//go:embed agent.json
var manifestJSON []byte

// Embedded returns the listener bundled by the release build.
func Embedded() (*Listener, error) { return Load(body, manifestJSON) }
