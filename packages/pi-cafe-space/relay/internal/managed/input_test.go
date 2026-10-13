package managed

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBoundedInputDoesNotWaitForPipe(t *testing.T){
	reader,writer:=io.Pipe();defer reader.Close()
	var released atomic.Int32
	p:=&boundedInput{pipe:writer,release:func(){released.Add(1)},queue:make(chan []byte,32),stop:make(chan struct{}),done:make(chan struct{}),timeout:30*time.Millisecond}
	go p.run();defer p.Close()
	start:=time.Now();if _,err:=p.Write([]byte("small command\n"));err!=nil{t.Fatal(err)}
	if time.Since(start)>100*time.Millisecond{t.Fatal("Write blocked on child stdin")}
	accepted:=1
	for i:=0;i<100;i++{if _,err:=p.Write([]byte("queued\n"));err==nil{accepted++}}
	if accepted>32{t.Fatal("queue limit exceeded",accepted)}
	select{case<-p.done:case<-time.After(time.Second):t.Fatal("blocked pipe was not cancelled")}
	if released.Load()==0{t.Fatal("owned process release not called")}
	p.mu.Lock();remaining,bytes:=p.count,p.bytes;p.mu.Unlock();if remaining!=0||bytes!=0{t.Fatal("queue budget leaked")}
}
func TestBoundedInputPreservesOrder(t *testing.T){
	reader,writer:=io.Pipe();defer reader.Close()
	p:=newBoundedInput(writer,nil);defer p.Close()
	read:=make(chan string,1);go func(){b:=make([]byte,6);_,err:=io.ReadFull(reader,b);if err==nil{read<-string(b)}}()
	for _,v:=range []string{"a\n","b\n","c\n"}{if _,err:=p.Write([]byte(v));err!=nil{t.Fatal(err)}}
	select{case value:=<-read:if value!="a\nb\nc\n"{t.Fatal("control message order changed")};case<-time.After(time.Second):t.Fatal("queued input not delivered")}
}
func TestCloseContextBoundsWaitingForStateLock(t *testing.T){
	var unlocked atomic.Int32
	m:=&Manager{active:map[string]*process{},unlock:func(){unlocked.Add(1)}}
	m.mu.Lock()
	ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel()
	if err:=m.CloseContext(ctx);!errors.Is(err,context.DeadlineExceeded){m.mu.Unlock();t.Fatal(err)}
	if unlocked.Load()!=0{m.mu.Unlock();t.Fatal("registry released before cleanup")}
	m.mu.Unlock()
	wait,cancelWait:=context.WithTimeout(context.Background(),time.Second);defer cancelWait()
	var wg sync.WaitGroup
	for i:=0;i<3;i++{wg.Add(1);go func(){defer wg.Done();if err:=m.CloseContext(wait);err!=nil{t.Error(err)}}()};wg.Wait()
	if unlocked.Load()!=1{t.Fatal("registry unlock did not happen exactly once")}
}
