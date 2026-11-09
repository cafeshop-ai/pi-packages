package collaboration

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOperatorNoExpirySurvivesAccessCleanupAndRestart(t *testing.T) {
	s := limited(t, Options{MaxRooms: 2})
	id, owner := create(t, s)
	invite := invitation(t, s, id, owner)
	other, otherOwner := create(t, s)
	// Simulate an offline operator change, not a remotely settable field.
	for _, key := range []string{id, other} {
		room := *s.rooms[key]
		room.Expires = time.Now().Add(-time.Hour)
		room.NoExpiry = key == id
		if err := s.save(&room); err != nil {
			t.Fatal(err)
		}
	}
	call(t, s, map[string]any{"op": "read", "roomId": id}, "", 401)
	read := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)
	if value, ok := read["expires"]; !ok || value != nil {
		t.Fatal("a permanent room must explicitly report expires:null")
	}
	preview := call(t, s, map[string]any{"op": "preview", "roomId": id, "invite": invite}, "", 200)
	if value, ok := preview["expires"]; !ok || value != nil {
		t.Fatal("preview must report expires:null")
	}
	member := join(t, s, id, invite, "AI")
	call(t, s, map[string]any{"op": "read", "roomId": other}, otherOwner, 404)
	call(t, s, createRoom, "", 200) // Sweeps the expired room, not the permanent one.
	if _, err := os.Stat(filepath.Join(s.directory, other+".json")); !os.IsNotExist(err) {
		t.Fatal("ordinary expired room was not cleaned")
	}
	restored, err := New(s.directory, testOrigin, Options{MaxRooms: 2})
	if err != nil {
		t.Fatal(err)
	}
	call(t, restored, map[string]any{"op": "read", "roomId": id}, owner, 200)
	call(t, restored, createRoom, "", 409) // Permanent rooms still consume capacity.
	call(t, restored, map[string]any{"op": "send", "roomId": id, "id": "still-writable", "text": "kept"}, owner, 200)
	if !restored.rooms[id].NoExpiry || restored.rooms[id].Expires.IsZero() {
		t.Fatal("normal writes lost the override or its original audit timestamp")
	}
	call(t, restored, map[string]any{"op": "remove", "roomId": id, "memberId": member["memberId"]}, owner, 200)
	call(t, restored, map[string]any{"op": "read", "roomId": id}, member["token"].(string), 401)
	call(t, restored, map[string]any{"op": "close", "roomId": id}, owner, 200)
	call(t, restored, map[string]any{"op": "read", "roomId": id}, owner, 410)
	call(t, restored, map[string]any{"op": "preview", "roomId": id, "invite": invite}, "", 403)
}

func TestNoExpiryRemainsOperatorOnlyAndDoesNotWeakenValidation(t *testing.T) {
	s := store(t)
	call(t, s, map[string]any{"op": "create", "title": "Room", "name": "Owner", "kind": "human", "noExpiry": true}, "", 400)
	id, owner := create(t, s)
	if s.rooms[id].NoExpiry || s.rooms[id].Expires.IsZero() {
		t.Fatal("new rooms must retain the default expiry")
	}
	call(t, s, map[string]any{"op": "read", "roomId": id, "noExpiry": true}, owner, 400)
	room := *s.rooms[id]
	room.NoExpiry, room.Expires = true, time.Time{}
	if validRoom(&room) {
		t.Fatal("even permanent records must retain a valid original expiry")
	}
}
