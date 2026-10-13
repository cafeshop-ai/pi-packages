package remote

import (
	"io"
	"mime"
	"net/http"
)

// This is a registration check, not authentication or a guarantee that WebRTC will connect.
func (c *Cloud) roomStatus(w http.ResponseWriter, r *http.Request, cfg Config) {
	if !cfg.RoomAccess || !cfg.EnableWebRTC {
		failHTTP(w, 404, "ROOM_UNAVAILABLE")
		return
	}
	if r.Method != "POST" {
		failHTTP(w, 405, "METHOD_NOT_ALLOWED")
		return
	}
	if !originMatches(r, cfg) || r.Header.Get("Authorization") != "" {
		failHTTP(w, 403, "ORIGIN_DENIED")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		failHTTP(w, 415, "JSON_REQUIRED")
		return
	}
	_, done, ok := c.admit(r)
	if !ok {
		failHTTP(w, 503, "CONNECTION_LIMIT")
		return
	}
	defer done()
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil {
		failHTTP(w, 413, "REQUEST_TOO_LARGE")
		return
	}
	var q struct {
		RoomKey string `json:"roomKey"`
	}
	if strictJSON(raw, &q) != nil {
		failHTTP(w, 400, "INVALID_REQUEST")
		return
	}
	if _, err := roomPublicKey(q.RoomKey); err != nil {
		failHTTP(w, 400, "INVALID_ROOM_KEY")
		return
	}
	c.mu.Lock()
	available := !c.closing && c.healthy && c.cfg.RoomAccess && c.cfg.EnableWebRTC
	online := c.roomHosts[q.RoomKey] != nil
	c.mu.Unlock()
	if !available {
		failHTTP(w, 503, "REMOTE_UNAVAILABLE")
		return
	}
	// Offline and retired/unknown keys are indistinguishable: no historical room registry is retained.
	reply(w, 200, map[string]bool{"online": online})
}
