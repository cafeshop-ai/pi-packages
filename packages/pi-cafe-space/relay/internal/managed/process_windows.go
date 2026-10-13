package managed

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// Resolve through the open Windows handle: filepath.EvalSymlinks cannot follow
// some pnpm junctions even though Windows and native Node can open the file.
func resolvedPath(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(f.Fd()), &buffer[0], uint32(len(buffer)), 0)
	if err != nil {
		return "", err
	}
	if n >= uint32(len(buffer)) {
		return "", errors.New("path too long")
	}
	value := windows.UTF16ToString(buffer[:n])
	if strings.HasPrefix(value, `\\?\UNC\`) {
		return `\\` + strings.TrimPrefix(value, `\\?\UNC\`), nil
	}
	return strings.TrimPrefix(value, `\\?\`), nil
}
func lockRegistry(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	overlap := &windows.Overlapped{}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlap)
	if err != nil {
		f.Close()
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, overlap); f.Close() }) }, nil
}
func prepareProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func RunSupervisor(args []string) (int, bool) { return 0, false }
func startOwnedProcess(cmd *exec.Cmd) (func(), error) {
	prepareProcess(cmd)
	if err := cmd.Start(); err != nil { return nil, err }
	release, err := ownProcess(cmd)
	if err != nil { _ = cmd.Process.Kill(); _ = cmd.Wait(); return nil, err }
	return release, nil
}

// Closing this job kills only this manager-owned process tree, including native
// tool children. Windows also closes the handle if the Relay crashes/exits.
func ownProcess(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	err = windows.AssignProcessToJobObject(job, handle)
	windows.CloseHandle(handle)
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(func() { windows.CloseHandle(job) }) }, nil
}
