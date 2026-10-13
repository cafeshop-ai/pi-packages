package remote

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/gorilla/websocket"
)

const maxOuterBytes = 512 * 1024
const maxLinkBytes = 2 * 1024 * 1024
const maxQueuedFrames = 128
const maxSDPBytes = 64 * 1024

var errClosed = errors.New("remote connection is closed")
var errCapacity = errors.New("remote connection capacity exceeded")

// Frame is an authenticated signalling/multiplexing envelope. Payload is base64
// on the JSON wire, so existing v1 bytes are never decoded/re-serialized by cloud.
// IDs are minted by the cloud and are bound to one device connection generation.
type Frame struct {
	RoomKey string `json:"roomKey,omitempty"`
	Nonce string `json:"nonce,omitempty"`
	Signature string `json:"signature,omitempty"`
	Type string `json:"type"`
	ID string `json:"id,omitempty"`
	Token string `json:"token,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Room string `json:"room,omitempty"`
	PeerID string `json:"peerId,omitempty"`
	UserID string `json:"userId,omitempty"`
	Name string `json:"name,omitempty"`
	Role string `json:"role,omitempty"`
	Mode string `json:"mode,omitempty"`
	Payload []byte `json:"payload,omitempty"`
	SDP string `json:"sdp,omitempty"`
	Code string `json:"code,omitempty"`
	WebRTC bool `json:"webRTC,omitempty"`
	Managed bool `json:"managed,omitempty"`
	ICEServers []ICEServer `json:"iceServers,omitempty"`
}
func (f Frame) valid() bool {
	if len(f.RoomKey)>128||len(f.Nonce)>64||len(f.Signature)>128{return false}
	if len(f.Type) > 32 || f.Type == "" || len(f.ID) > 128 || len(f.Token) > 128 || len(f.DeviceID) > 64 || len(f.Room) > 64 || len(f.PeerID) > 128 || len(f.UserID) > 64 || len(f.Name) > 128 || len(f.Role) > 16 || len(f.Mode) > 16 || len(f.Code) > 64 || len(f.Payload) > protocol.MaxFrameBytes || len(f.SDP) > maxSDPBytes { return false }
	return validateICE(f.ICEServers) == nil
}
func decodeFrame(raw []byte) (Frame, error) {
	var f Frame
	if len(raw) > maxOuterBytes || !utf8.Valid(raw) { return f, errors.New("invalid remote frame size/encoding") }
	if err := strictJSON(raw, &f); err != nil { return f, err }
	if !f.valid() { return f, errors.New("invalid remote frame") }
	return f, nil
}

type byteBudget struct { mu sync.Mutex; used, limit int }
func (b *byteBudget) reserve(n int) bool {
	if b == nil { return true }
	b.mu.Lock(); defer b.mu.Unlock()
	if n < 0 || b.used+n > b.limit { return false }
	b.used += n; return true
}
func (b *byteBudget) release(n int) {
	if b == nil { return }
	b.mu.Lock(); b.used -= n; b.mu.Unlock()
}

type wsLink struct {
	conn *websocket.Conn
	budget *byteBudget
	queue chan []byte
	stop chan struct{}
	done chan struct{}
	mu sync.Mutex
	closing bool
	bytes int
	count int
}
func newWSLink(conn *websocket.Conn, budget *byteBudget) *wsLink {
	l := &wsLink{conn:conn,budget:budget,queue:make(chan []byte,maxQueuedFrames),stop:make(chan struct{}),done:make(chan struct{})}
	conn.SetReadLimit(maxOuterBytes)
	_ = conn.SetReadDeadline(time.Now().Add(70*time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(70*time.Second)) })
	go l.writePump()
	return l
}
func (l *wsLink) Send(f Frame) error {
	if !f.valid() { return errors.New("invalid outbound remote frame") }
	b, err := json.Marshal(f)
	if err != nil || len(b) > maxOuterBytes { return errors.New("outbound remote frame too large") }
	l.mu.Lock()
	if l.closing { l.mu.Unlock(); return errClosed }
	if l.count >= maxQueuedFrames || l.bytes+len(b) > maxLinkBytes || !l.budget.reserve(len(b)) {
		l.mu.Unlock(); l.Close(); return errCapacity
	}
	l.bytes += len(b); l.count++
	l.queue <- b
	l.mu.Unlock()
	return nil
}
func (l *wsLink) Read() (Frame, error) {
	kind, raw, err := l.conn.ReadMessage()
	if err != nil { return Frame{}, err }
	if kind != websocket.TextMessage { return Frame{}, errors.New("remote signalling requires JSON text") }
	_ = l.conn.SetReadDeadline(time.Now().Add(70*time.Second))
	return decodeFrame(raw)
}
func (l *wsLink) Close() {
	l.mu.Lock()
	if l.closing { l.mu.Unlock(); return }
	l.closing = true; close(l.stop); l.mu.Unlock()
	// Close is safe concurrently with a reader/writer and unblocks both. No
	// network or actor wait occurs while holding a registry or queue mutex.
	_ = l.conn.Close()
}
func (l *wsLink) release(n int) { l.mu.Lock(); l.bytes-=n; l.count--; l.mu.Unlock(); l.budget.release(n) }
func (l *wsLink) writePump() {
	defer func() {
		l.Close()
		defer close(l.done)
		for { select { case b := <-l.queue: l.release(len(b)); default: return } }
	}()
	ticker:=time.NewTicker(25*time.Second); defer ticker.Stop()
	for {
		select { case <-l.stop:return; default: }
		select {
		case <-l.stop:return
		case b:= <-l.queue:
			_ = l.conn.SetWriteDeadline(time.Now().Add(5*time.Second))
			err:=l.conn.WriteMessage(websocket.TextMessage,b); l.release(len(b)); if err!=nil{return}
		case <-ticker.C:
			if l.conn.WriteControl(websocket.PingMessage,nil,time.Now().Add(time.Second))!=nil{return}
		}
	}
}

// Reject duplicate (including case-aliased) keys before Go's struct decoder can
// silently choose a different identity/operation. Nesting is explicitly bounded.
func uniqueJSON(raw []byte) error {
	d := json.NewDecoder(strings.NewReader(string(raw))); d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth>64{return errors.New("JSON nesting limit exceeded")}
		t,err:=d.Token(); if err!=nil{return err}
		delim,ok:=t.(json.Delim); if !ok{return nil}
		switch delim {
		case '{':
			seen:=map[string]bool{}
			for d.More(){ k,err:=d.Token(); if err!=nil{return err}; key,ok:=k.(string); if !ok{return errors.New("invalid object key")}; key=strings.ToLower(key); if seen[key]{return errors.New("duplicate JSON key")}; seen[key]=true; if err=value(depth+1);err!=nil{return err} }
			end,err:=d.Token(); if err!=nil||end!=json.Delim('}'){return errors.New("invalid object end")}
		case '[':
			for d.More(){if err=value(depth+1);err!=nil{return err}}; end,err:=d.Token();if err!=nil||end!=json.Delim(']'){return errors.New("invalid array end")}
		default:return errors.New("invalid delimiter")
		}
		return nil
	}
	if !utf8.Valid(raw){return errors.New("invalid UTF-8")}
	if err:=value(0);err!=nil{return err}
	if _,err:=d.Token();err!=io.EOF{return errors.New("trailing JSON data")}
	return nil
}
