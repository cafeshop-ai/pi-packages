package managed

import (
	"errors"
	"io"
	"sync"
	"time"
)

// boundedInput admits small RPC control messages without blocking the manager's
// state mutex. One writer preserves order; no unbounded goroutine per message.
type boundedInput struct {
	pipe io.WriteCloser
	release func()
	mu sync.Mutex
	closing bool
	bytes int
	count int
	queue chan []byte
	stop chan struct{}
	done chan struct{}
	timeout time.Duration
}
func newBoundedInput(pipe io.WriteCloser, release func()) *boundedInput {
	p := &boundedInput{pipe:pipe,release:release,queue:make(chan []byte,32),stop:make(chan struct{}),done:make(chan struct{}),timeout:5*time.Second}
	go p.run()
	return p
}
func (p *boundedInput) Write(b []byte) (int,error) {
	p.mu.Lock(); defer p.mu.Unlock()
	if p.closing { return 0, io.ErrClosedPipe }
	if len(b) == 0 { return 0,nil }
	if len(b)>4096 || p.count>=32 || p.bytes+len(b)>64*1024 { return 0,errors.New("managed RPC input capacity exceeded") }
	p.bytes+=len(b);p.count++;p.queue<-append([]byte(nil),b...)
	return len(b),nil
}
func (p *boundedInput) Close() error {
	p.mu.Lock();if p.closing {p.mu.Unlock();return nil};p.closing=true;close(p.stop);p.mu.Unlock()
	return p.pipe.Close()
}
func (p *boundedInput) complete(n int){p.mu.Lock();p.bytes-=n;p.count--;p.mu.Unlock()}
func (p *boundedInput) run(){
	defer func(){_ = p.Close();defer close(p.done);for{select{case b:=<-p.queue:p.complete(len(b));default:return}}}()
	for{select{case<-p.stop:return;default:};select{case<-p.stop:return;case b:=<-p.queue:
		timedOut:=make(chan struct{})
		timer:=time.AfterFunc(p.timeout,func(){_ = p.pipe.Close();if p.release!=nil{p.release()};close(timedOut)})
		written,err:=p.pipe.Write(b)
		if !timer.Stop(){<-timedOut}
		p.complete(len(b))
		if err!=nil||written!=len(b){if p.release!=nil{p.release()};return}
	}}
}
