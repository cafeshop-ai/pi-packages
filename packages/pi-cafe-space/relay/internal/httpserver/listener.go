package httpserver

import (
	"net"
	"net/http"
	"sync"
	"sync/atomic"
)

const MaxConnections = 512

type Server struct{ *http.Server }

func (s *Server) Serve(listener net.Listener) error {
	return s.Server.Serve(&boundedListener{Listener: listener, max: MaxConnections})
}

type boundedListener struct {
	net.Listener
	active atomic.Int64
	max    int64
}
type countedConn struct {
	net.Conn
	once  sync.Once
	owner *boundedListener
}

func (c *countedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.active.Add(-1) })
	return err
}
func (l *boundedListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		if l.active.Add(1) > l.max {
			l.active.Add(-1)
			_ = c.Close()
			continue
		}
		return &countedConn{Conn: c, owner: l}, nil
	}
}
