//go:build webembed

package agentdist

import "embed"

//go:embed agent.json space-agent.mjs cafe-room.js
var embedded embed.FS

// Embedded returns the files bundled by the release build.
func Embedded() (*Bundle, error) {
	manifest, err := embedded.ReadFile("agent.json")
	if err != nil {
		return nil, err
	}
	return Load(manifest, embedded.ReadFile)
}
