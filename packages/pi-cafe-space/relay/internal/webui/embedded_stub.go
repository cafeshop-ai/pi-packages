//go:build !webembed

package webui

// Source-only tests/debug builds deliberately serve the existing explicit 503.
func Embedded() (*Assets, string, error) { return nil, "", nil }
