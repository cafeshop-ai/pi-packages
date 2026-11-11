//go:build !webembed

package agentdist

// Source-only test and debug builds carry no bundle; the server then offers no listener and the
// guide keeps only the HTTP steps.
func Embedded() (*Listener, error) { return nil, nil }
