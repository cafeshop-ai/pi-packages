package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/managed"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/service"
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/webui"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

// This candidate entry point is not used by the existing package launcher.
// Production candidates require the webembed build tag and verified assets.
var version = "development"

func main() {
	if code, handled := managed.RunSupervisor(os.Args[1:]); handled { os.Exit(code) }
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		_, digest, err := webui.Embedded()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"version": version, "webDigest": digest, "platform": runtime.GOOS + "-" + runtime.GOARCH})
		return
	}
	env := map[string]string{}
	for _, key := range []string{"PI_COLLAB_HOST", "PI_COLLAB_PORT", "PI_COLLAB_HOST_TOKEN", "PI_COLLAB_CLIENT_TOKEN", "PI_COLLAB_ALLOWED_ORIGINS", "PI_COLLAB_MANAGED_CONFIG", "PI_CAFE_REMOTE_CONFIG", "PI_CAFE_CREDENTIALS_FILE"} {
		if v, ok := os.LookupEnv(key); ok {
			env[key] = v
		}
	}
	cfg, err := config.Parse(env)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if cfg.CredentialsFile == "" && config.NeedsLocalSetup(cfg) {
		home, e := os.UserHomeDir()
		if e != nil { fmt.Fprintln(os.Stderr, "Cannot locate local Café Space configuration"); os.Exit(1) }
		cfg.CredentialsFile = filepath.Join(home, ".config", "pi-cafe-space", fmt.Sprintf("credentials-%d.json", cfg.Port))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg); err != nil {
		fmt.Fprintln(os.Stderr, "Relay listener failed:", err)
		os.Exit(1)
	}
}
func run(ctx context.Context, cfg config.Config) error {
	assets, _, err := webui.Embedded()
	if err != nil {
		return err
	}
	if assets == nil {
		fmt.Fprintln(os.Stderr, "Relay candidate: Web assets are not built yet")
	}
	server, err := service.New(cfg, service.Options{Assets: assets})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		_ = server.Close(context.Background())
		return err
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Close(shutdown)
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := server.Close(shutdown)
		serveErr := <-done
		if err != nil {
			return err
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
		return nil
	}
}
