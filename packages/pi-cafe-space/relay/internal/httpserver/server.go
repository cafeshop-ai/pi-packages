package httpserver

import (
	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/webui"
	"github.com/gin-gonic/gin"
	"net/http"
	"time"
)

var securityHeaders = map[string]string{
	"Cache-Control":                "no-store",
	"X-Content-Type-Options":       "nosniff",
	"X-Frame-Options":              "DENY",
	"Referrer-Policy":              "no-referrer",
	"Permissions-Policy":           "camera=(), microphone=(), geolocation=()",
	"Cross-Origin-Opener-Policy":   "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Content-Security-Policy":      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
}

func NewHandler(assets *webui.Assets, websocketHandler ...http.Handler) http.Handler {
	var ws http.Handler
	if len(websocketHandler) == 1 {
		ws = websocketHandler[0]
	}
	return NewManagedHandler(assets, ws, nil)
}
func NewManagedHandler(assets *webui.Assets, websocketHandler http.Handler, managedHandler http.Handler, publicOrigin ...string) http.Handler {
	configuredPolicy := ""
	if len(publicOrigin)==1 && publicOrigin[0]!="" { configuredPolicy=WebSocketContentSecurityPolicy(publicOrigin[0]) }
	router := gin.New()
	router.RedirectTrailingSlash = false
	router.RedirectFixedPath = false
	router.HandleMethodNotAllowed = true
	router.ForwardedByClientIP = false
	router.RemoveExtraSlash = false
	router.UseRawPath = true
	router.UnescapePathValues = false
	if err := router.SetTrustedProxies(nil); err != nil {
		panic("invalid fixed proxy policy")
	}
	body := func(c *gin.Context, status int, contentType string, value []byte) {
		c.Header("Content-Type", contentType)
		if c.Request.Method == http.MethodHead {
			c.Status(status)
		} else {
			c.Data(status, contentType, value)
		}
	}
	notFound := func(c *gin.Context) { body(c, 404, "text/plain; charset=utf-8", []byte("Not found")) }
	router.NoMethod(func(c *gin.Context) { c.Header("Allow", "GET, HEAD"); c.Status(405) })
	router.NoRoute(func(c *gin.Context) {
		pathname := c.Request.URL.EscapedPath()
		if b, mime, ok := assets.Get(pathname); ok {
			body(c, 200, mime, b)
			return
		}
		if pathname == "/" || pathname == "/index.html" {
			body(c, 503, "text/plain; charset=utf-8", []byte("Web client is not built"))
			return
		}
		notFound(c)
	})
	if websocketHandler != nil {
		router.GET("/ws", func(c *gin.Context) { websocketHandler.ServeHTTP(c.Writer, c.Request) })
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		router.Handle(method, "/healthz", func(c *gin.Context) {
			body(c, 200, "application/json; charset=utf-8", []byte(`{"ok":true,"protocolVersion":1}`))
		})
		router.Handle(method, "/api/config", func(c *gin.Context) {
			value := `{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main"}`
			if managedHandler != nil {
				value = `{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main","managedSessions":true}`
			}
			body(c, 200, "application/json; charset=utf-8", []byte(value))
		})
	}
	// Keep admission outside Gin so rejected encoded paths/methods retain security
	// headers without letting Gin decode or redirect them into an allowed route.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range securityHeaders {
			w.Header().Set(k, v)
		}
		policy:=configuredPolicy;if policy==""{policy=localPageContentSecurityPolicy(r)}
		w.Header().Set("Content-Security-Policy",policy)
		if managedHandler != nil && r.URL.Path == "/api/workspace" && r.URL.RawPath == "" && r.URL.EscapedPath() == r.URL.Path {
			managedHandler.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			w.Header().Set("Connection", "close")
			w.WriteHeader(405)
			return
		}
		if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
			w.Header().Set("Connection", "close")
			w.WriteHeader(413)
			return
		}
		// Any encoded path differs from the literal allowlist. Query strings do not
		// carry credentials and are ignored just as in the old HTTP endpoints.
		if r.URL.RawPath != "" || r.URL.EscapedPath() != r.URL.Path {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(404)
			if r.Method != http.MethodHead {
				_, _ = w.Write([]byte("Not found"))
			}
			return
		}
		defer func() {
			if recover() != nil {
				w.Header().Set("Connection", "close")
				w.WriteHeader(500)
			}
		}()
		router.ServeHTTP(w, r)
	})
}
func NewServer(handler http.Handler) *Server {
	return &Server{Server: &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 16 * 1024}}
}
