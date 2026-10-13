//go:build darwin || linux

package managed

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func assertGroupGone(t *testing.T,group int){
	t.Helper();deadline:=time.Now().Add(5*time.Second)
	for time.Now().Before(deadline){if unix.Kill(-group,0)==unix.ESRCH{return};time.Sleep(10*time.Millisecond)}
	t.Fatalf("owned process group %d was not reaped",group)
}
func TestSupervisorReapsGroupAfterManagerCrash(t *testing.T){
	executable,err:=os.Executable();if err!=nil{t.Fatal(err)}
	owner:=exec.Command(executable,"--managed-test-owner")
	out,err:=owner.StdoutPipe();if err!=nil{t.Fatal(err)}
	if err=owner.Start();err!=nil{t.Fatal(err)}
	waited:=false
	defer func(){if !waited{_ = owner.Process.Kill();_ = owner.Wait()};_ = out.Close()}()
	lines:=make(chan string,2)
	go func(){scanner:=bufio.NewScanner(out);for scanner.Scan(){lines<-scanner.Text();if len(lines)==cap(lines){return}};close(lines)}()
	group,pid,grandchild:=0,0,0
	deadline:=time.NewTimer(5*time.Second);defer deadline.Stop()
	for group==0||pid==0||grandchild==0{
		select{case line,ok:=<-lines:
			if !ok{t.Fatal("owner helper exited early")}
			if strings.HasPrefix(line,"supervisor:"){_,err=fmt.Sscanf(line,"supervisor:%d",&group)}else{_,err=fmt.Sscanf(line,"tree:%d:%d",&pid,&grandchild)}
			if err!=nil{t.Fatal(err)}
		case<-deadline.C:t.Fatal("owner helper did not create its process tree")}
	}
	if group==os.Getpid()||group==owner.Process.Pid{t.Fatal("supervisor does not own a separate group")}
	for _,child:=range []int{pid,grandchild}{actual,err:=unix.Getpgid(child);if err!=nil||actual!=group{t.Fatal("child is outside owned group",err)}}
	// Simulate a hard crash; no application shutdown handler runs in the owner.
	if err=owner.Process.Kill();err!=nil{t.Fatal(err)}
	_ = owner.Wait();waited=true
	assertGroupGone(t,group)
}
func TestSupervisorGracefulLeaseRelease(t *testing.T){
	executable,_:=os.Executable();cmd:=exec.Command(executable,"--managed-test-tree")
	input,err:=cmd.StdinPipe();if err!=nil{t.Fatal(err)}
	out,err:=cmd.StdoutPipe();if err!=nil{t.Fatal(err)}
	release,err:=startOwnedProcess(cmd);if err!=nil{t.Fatal(err)}
	defer release();defer input.Close();defer out.Close()
	ready:=make(chan bool,1);go func(){scanner:=bufio.NewScanner(out);ready<-scanner.Scan()}()
	select{case ok:=<-ready:if !ok{t.Fatal("tree did not start")};case<-time.After(5*time.Second):release();_ = cmd.Wait();t.Fatal("tree startup timeout")}
	group:=cmd.Process.Pid
	release();_ = cmd.Wait()
	assertGroupGone(t,group)
}
func TestRegistryRejectsSymbolicLink(t *testing.T){
	root:=t.TempDir();target:=filepath.Join(root,"target");if err:=os.WriteFile(target,[]byte("keep"),0600);err!=nil{t.Fatal(err)}
	link:=filepath.Join(root,"registry.lock");if err:=os.Symlink(target,link);err!=nil{t.Fatal(err)}
	if unlock,err:=lockRegistry(link);err==nil{unlock();t.Fatal("symlink used as registry lock")}
}
func TestSupervisorRequiresInheritedOwnership(t *testing.T){
	if code,handled:=RunSupervisor([]string{supervisorArgument,"/bin/echo","unsafe"});!handled||code!=64{t.Fatal("unowned supervisor call was not rejected")}
}
