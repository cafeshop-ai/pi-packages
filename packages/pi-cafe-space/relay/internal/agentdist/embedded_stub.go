//go:build !webembed

package agentdist

// Source-only test and debug builds carry no bundle; the server then offers no files and the
// guide keeps only the HTTP steps.
func Embedded() (*Bundle, error) { return nil, nil }
