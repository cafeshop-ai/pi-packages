//go:build !windows && !darwin && !linux

package managed

import (
	"errors"
	"os/exec"
	"path/filepath"
)

func resolvedPath(path string) (string, error) { return filepath.EvalSymlinks(path) }
func lockRegistry(path string) (func(), error) {
	return nil, errors.New("managed Pi is unsupported on this platform")
}
func prepareProcess(cmd *exec.Cmd) {}
func RunSupervisor(args []string) (int, bool) { return 0, false }
func startOwnedProcess(cmd *exec.Cmd) (func(), error) { return nil, errors.New("managed Pi process ownership is unsupported on this platform") }
func ownProcess(cmd *exec.Cmd) (func(), error) {
	return nil, errors.New("managed Pi process ownership is unsupported on this platform")
}
