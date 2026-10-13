package remote

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRoomAuthenticationHasSeparateHelloDeadline(t *testing.T) {
	f := roomFixture(t, false)
	id, _ := NewToken()
	nonce, _ := NewToken()
	f.agent.mu.Lock()
	link := f.agent.link
	f.agent.mu.Unlock()
	// Keep this session outside the maintenance loop so expiry assertions use a deterministic clock.
	s := newRemoteSession(f.agent, link, Identity{ID: id, UserID: "guest-" + id, Name: "Guest", Room: "main", Role: "operator"}, "webrtc", nil)
	s.roomKey, s.roomRevision = f.agent.room.snapshot()
	s.browserNonce = nonce
	s.chosen = "webrtc"
	s.selectedAt = time.Now().Add(-4 * time.Second)
	t.Cleanup(func() {
		if s.connection != nil {
			f.h.Leave(s.connection)
		}
		f.agent.control.Leave(id)
		for {
			select {
			case b := <-s.out:
				s.release(len(b), false)
			default:
				return
			}
		}
	})
	if !s.expired(s.selectedAt.Add(6 * time.Second)) {
		t.Fatal("unauthenticated room has no deadline")
	}
	raw, err := json.Marshal(map[string]any{"type": "room.auth", "id": id, "nonce": nonce, "password": "123456"})
	if err != nil {
		t.Fatal(err)
	}
	verifiedStart := time.Now()
	if err = s.roomAuthentication(raw); err != nil {
		t.Fatal(err)
	}
	if !s.roomVerified || s.authenticated.Load() {
		t.Fatal("password verification must not bypass the client hello")
	}
	if s.expired(s.selectedAt.Add(5100 * time.Millisecond)) {
		t.Fatal("successful password verification consumed the subsequent hello budget")
	}
	if !s.expired(time.Now().Add(6 * time.Second)) {
		t.Fatal("missing hello can keep the connection alive")
	}
	if s.roomAuthentication(raw) == nil {
		t.Fatal("replayed room auth renewed the handshake deadline")
	}
	if err := s.handle([]byte(`{"type":"hello","protocolVersion":1,"peerRole":"client","peerId":"handshake-test","roomId":"main","token":"remote-session"}`)); err != nil {
		t.Fatal(err)
	}
	if !s.authenticated.Load() {
		t.Fatal("valid hello was not accepted")
	}
	events := s.trace.events
	for _, stage := range []string{"ROOM_VERIFIED", "HELLO_RECEIVED", "HELLO_ACCEPTED"} {
		found := false
		for _, event := range events {
			if event.Step == "handshake" && event.State == stage {
				found = true
			}
		}
		if !found {
			t.Fatal("missing safe handshake diagnostic", stage)
		}
	}
	if s.expired(verifiedStart.Add(6 * time.Second)) {
		t.Fatal("completed hello still uses the handshake deadline")
	}
	if !s.expired(s.authorizedUntil.Add(time.Millisecond)) {
		t.Fatal("room handshake disabled signaling authorization expiry")
	}
	s.accountUntil = verifiedStart.Add(time.Second)
	if !s.expired(s.accountUntil) {
		t.Fatal("room handshake disabled account expiry")
	}
}

func TestLegacyRemoteHelloDeadlineIsUnchanged(t *testing.T) {
	now := time.Now()
	s := &remoteSession{chosen: "webrtc", selectedAt: now, authorizedUntil: now.Add(45 * time.Second)}
	if s.expired(now.Add(4*time.Second)) || !s.expired(now.Add(6*time.Second)) {
		t.Fatal("legacy hello deadline changed")
	}
}
