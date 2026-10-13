package main

import (
	"context"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
	"net"
	"testing"
	"time"
)

func TestOwnedPortConflictReturnsWithoutKillingOwner(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e := run(ctx, config.Config{Host: "127.0.0.1", Port: port, HostToken: "host", ClientToken: "client"}); e == nil {
		t.Fatal("conflict not reported")
	}
	c, e := net.DialTimeout("tcp", l.Addr().String(), time.Second)
	if e != nil {
		t.Fatal("existing owner was closed", e)
	}
	c.Close()
}
func TestCancelledCandidateReleasesOwnListener(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, config.Config{Host: "127.0.0.1", Port: 0, HostToken: "host", ClientToken: "client"})
	}()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("run leaked")
	}
}
