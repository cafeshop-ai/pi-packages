//go:build darwin || linux

package managed

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

const supervisorArgument = "--pi-cafe-managed-supervisor"

func resolvedPath(path string) (string, error) { return filepath.EvalSymlinks(path) }
func lockRegistry(path string) (func(), error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil { return nil, err }
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil { _ = unix.Close(fd); return nil, err }
	var once sync.Once
	return func() { once.Do(func() { _ = unix.Flock(fd, unix.LOCK_UN); _ = unix.Close(fd) }) }, nil
}

// The supervisor owns a fresh process group and a read end of a liveness pipe.
// Only this manager holds the write end. Manager exit/crash closes it in the OS;
// the supervisor then kills its own group, including ordinary tool descendants.
// This is process ownership, not a security sandbox: a program explicitly
// detaching into another session is outside POSIX process-group containment.
func startOwnedProcess(cmd *exec.Cmd) (func(), error) {
	if len(cmd.ExtraFiles) != 0 { return nil, errors.New("unexpected inherited descriptors") }
	executable, err := os.Executable()
	if err != nil { return nil, err }
	read, write, err := os.Pipe()
	if err != nil { return nil, err }
	target, arguments := cmd.Path, append([]string{}, cmd.Args[1:]...)
	cmd.Path = executable
	cmd.Args = append([]string{executable, supervisorArgument, target}, arguments...)
	cmd.ExtraFiles = []*os.File{read}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = cmd.Start(); err != nil { _ = read.Close(); _ = write.Close(); return nil, err }
	_ = read.Close()
	var once sync.Once
	return func() { once.Do(func() { _ = write.Close() }) }, nil
}

// RunSupervisor is an internal entry point in the same executable. FD 3 must be
// the manager's inherited pipe and this process must lead its own group. It does
// not use a network request, discover another process or reuse a persisted PID.
func RunSupervisor(args []string) (int, bool) {
	if len(args) == 0 || args[0] != supervisorArgument { return 0, false }
	if len(args) < 2 || !filepath.IsAbs(args[1]) || unix.Getpgrp() != os.Getpid() { return 64, true }
	lease := os.NewFile(3, "managed-parent-lease")
	if lease == nil { return 64, true }
	info, err := lease.Stat()
	if err != nil || info.Mode()&os.ModeNamedPipe == 0 { _ = lease.Close(); return 64, true }
	unix.CloseOnExec(3)
	parentGone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, lease); _ = lease.Close(); close(parentGone) }()
	select { case <-parentGone: return 0, true; default: }
	cmd := exec.Command(args[1], args[2:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ() // already the manager's explicit child environment
	if err = cmd.Start(); err != nil { return 127, true }
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopping)
	select { case <-parentGone: case <-exited: case <-stopping: }
	// The supervisor itself still anchors this process-group ID, so it cannot
	// have been reused for an unrelated process between observation and kill.
	_ = unix.Kill(0, unix.SIGKILL)
	return 1, true // reached only if the kernel refused our own-group signal
}
