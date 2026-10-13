package httpserver

import (
	"errors"
	"net"
	"testing"
)

type scriptedListener struct{ connections []net.Conn }

func (l *scriptedListener) Accept() (net.Conn, error) {
	if len(l.connections) == 0 {
		return nil, net.ErrClosed
	}
	c := l.connections[0]
	l.connections = l.connections[1:]
	return c, nil
}
func (l *scriptedListener) Close() error   { return nil }
func (l *scriptedListener) Addr() net.Addr { return &net.TCPAddr{} }
func TestConnectionAdmissionAndReleaseOnce(t *testing.T) {
	a, pa := net.Pipe()
	defer pa.Close()
	b, pb := net.Pipe()
	defer pb.Close()
	l := &boundedListener{Listener: &scriptedListener{connections: []net.Conn{a, b}}, max: 1}
	c, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
	if l.active.Load() != 1 {
		t.Fatal("overload leaked quota")
	}
	_ = c.Close()
	_ = c.Close()
	if l.active.Load() != 0 {
		t.Fatal("double close released quota twice")
	}
}
