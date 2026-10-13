// Package service assembles HTTP, transport and the in-memory hub. No default
// listener, process, file, provider or model is started by construction.
package service

import (
	"context"
	"errors"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/auth"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/httpserver"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/hub"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/remote"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/transport"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/webui"
	"net"
	"net/http"
	"strconv"
	"sync"
)

type Options struct {
	Hub       hub.Options
	Transport transport.Options
	Assets    *webui.Assets
}
type Service struct {
	local *localSetup
	cloud *remote.Cloud
	agent *remote.Agent
	managed *managed.Manager
	Hub     *hub.Hub
	HTTP    *httpserver.Server
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	closing bool
	wg      sync.WaitGroup
	done    chan struct{}
}
type delayedSender struct {
	mu      sync.Mutex
	session *transport.Session
	closed  bool
	code    int
	reason  string
}

func (d *delayedSender) bind(s *transport.Session) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.session = s
	if d.closed {
		s.Close(d.code, d.reason)
	}
}
func (d *delayedSender) Send(b []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.session == nil || d.closed {
		return transport.ErrClosed
	}
	return d.session.Send(b)
}
func (d *delayedSender) Close(code int, reason string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	d.closed = true
	d.code = code
	d.reason = reason
	if d.session != nil {
		d.session.Close(code, reason)
	}
}
func New(cfg config.Config, options Options) (*Service, error) {
	if cfg.CredentialsFile != "" { return newLocalSetup(cfg, options) }
	var remoteConfig remote.Config
	if cfg.RemoteConfig != "" {
		var err error
		remoteConfig, err = remote.Load(cfg.RemoteConfig)
		if err != nil { return nil, err }
		if remoteConfig.Mode == "cloud" && cfg.ManagedConfig != "" { return nil, errors.New("cloud mode cannot manage local Pi processes") }
		ip := net.ParseIP(cfg.Host)
		if remoteConfig.Mode == "device" && cfg.Host != "localhost" && (ip == nil || !ip.IsLoopback()) { return nil, errors.New("device mode requires a loopback listener") }
	}
	if cfg.ManagedRoomCredentials && (remoteConfig.Mode!="device" || remoteConfig.RoomIdentityFile=="" || !remoteConfig.RoomManagement) { return nil,errors.New("user-chosen managed credentials require an explicitly enabled office room") }
	origins, err := auth.NewOrigins(cfg.AllowedOrigins)
	if err != nil {
		return nil, err
	}
	options.Hub.HostToken = cfg.HostToken
	options.Hub.ClientToken = cfg.ClientToken
	h := hub.New(options.Hub)
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{Hub: h, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	options.Transport.ReserveBytes = h.ReserveQueue
	options.Transport.ReleaseBytes = h.ReleaseQueue
	ws := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			http.Error(w, "Relay is shutting down", 503)
			return
		}
		s.wg.Add(1)
		s.mu.Unlock()
		defer s.wg.Done()
		address, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			address = r.RemoteAddr
		}
		sender := &delayedSender{}
		c, err := h.Join(sender, address)
		if err != nil {
			http.Error(w, "Relay connection capacity exceeded", 503)
			return
		}
		defer h.Leave(c)
		transport.Handler(ctx, origins, options.Transport, func(session *transport.Session) {
			sender.bind(session)
			session.Run(ctx, func(_ *transport.Session, b []byte) {
				if err := h.Handle(c, b); err != nil {
					session.Close(1013, "Relay is unavailable")
					return
				}
				if c.Authenticated() {
					session.MarkAuthenticated()
				}
			})
		}).ServeHTTP(w, r)
	})
	var managerHandler http.Handler
	if cfg.ManagedConfig != "" {
		manager, err := managed.Load(cfg.ManagedConfig, "ws://"+net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))+"/ws", cfg.HostToken)
		if err != nil {
			h.Close()
			cancel()
			return nil, err
		}
		s.managed = manager
		managerHandler = manager.Handler(cfg.ClientToken, origins)
	}
	pageOrigin := ""
	if remoteConfig.Mode=="cloud" { pageOrigin=remoteConfig.PublicOrigin }
	handler := httpserver.NewManagedHandler(options.Assets, ws, managerHandler, pageOrigin)
	if cfg.RemoteConfig != "" {
		if remoteConfig.Mode == "cloud" {
			s.cloud, err = remote.NewCloud(remoteConfig, cfg.RemoteConfig)
			if err == nil { handler = s.cloud.Wrap(handler) }
		} else {
			backend := remote.AgentBackend{Hub: h, ClientToken: cfg.ClientToken, HostToken: cfg.HostToken}
			if s.managed != nil { backend.Manager = s.managed }
			s.agent, err = remote.NewAgent(remoteConfig, backend)
			if err == nil { handler = s.agent.WrapRoomLocal(handler) }
		}
		if err != nil {
			if s.managed != nil { s.managed.Close() }
			h.Close(); cancel(); return nil, err
		}
	}
	s.HTTP = httpserver.NewServer(handler)
	return s, nil
}
func (s *Service) Serve(listener net.Listener) error {
	s.mu.Lock()
	if s.closing { s.mu.Unlock(); return http.ErrServerClosed }
	if s.cloud != nil { s.cloud.Start(s.ctx) }
	if s.agent != nil { s.agent.Start(s.ctx) }
	s.mu.Unlock()
	return s.HTTP.Serve(listener)
}
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.closing {
		done := s.done
		s.mu.Unlock()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.closing = true
	s.mu.Unlock()
	defer close(s.done)
	if s.local != nil {
		s.cancel()
		localErr := s.local.close(ctx)
		httpErr := s.HTTP.Shutdown(ctx)
		if httpErr != nil { _ = s.HTTP.Close() }
		return errors.Join(localErr, httpErr)
	}
	if s.cloud != nil { s.cloud.Close() }
	if s.agent != nil { s.agent.Close(); _ = s.agent.Wait(ctx) }
	var managedErr error
	if s.managed != nil {
		managedErr = s.managed.CloseContext(ctx)
	}
	s.Hub.Close()
	s.cancel()
	err := s.HTTP.Shutdown(ctx)
	if err != nil {
		_ = s.HTTP.Close()
	}
	// Session write/close deadlines cap joining hijacked connections; shutdown
	// never relies on http.Server tracking upgraded sockets.
	joined := make(chan struct{})
	go func() { s.wg.Wait(); close(joined) }()
	select {
	case <-joined:
	case <-ctx.Done():
		return ctx.Err()
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return errors.Join(err, managedErr)
}
