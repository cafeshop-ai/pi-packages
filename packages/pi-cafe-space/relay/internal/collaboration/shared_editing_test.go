package collaboration

import "testing"

func TestMembersManageRoomAfterCreatorLeavesOrIsRemoved(t *testing.T) {
	for _, operation := range []string{"leave", "remove"} {
		t.Run(operation, func(t *testing.T) {
			s := store(t)
			id, owner := create(t, s)
			ownerID := call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 200)["memberId"]
			invite := invitation(t, s, id, owner)
			human := call(t, s, map[string]any{"op": "join", "roomId": id, "invite": invite, "name": "Member", "kind": "human"}, "", 200)
			ai := join(t, s, id, invite, "AI")
			h, a := human["token"].(string), ai["token"].(string)
			for _, op := range []string{"remove", "revoke", "pause", "close", "goal", "task"} {
				call(t, s, map[string]any{"op": op, "roomId": id}, "", 401)
			}
			if operation == "leave" {
				call(t, s, map[string]any{"op": "leave", "roomId": id}, owner, 200)
			} else {
				call(t, s, map[string]any{"op": "remove", "roomId": id, "memberId": ownerID}, h, 200)
			}
			call(t, s, map[string]any{"op": "read", "roomId": id}, owner, 401)
			goalChange(t, s, id, a, "create", map[string]any{"title": "Shared goal", "criteria": "Members can edit", "reviewer": human["memberId"]}, 200)
			goalChange(t, s, id, h, "pause", nil, 200)
			goalChange(t, s, id, a, "resume", nil, 200)
			goalChange(t, s, id, a, "reviewer", map[string]any{"reviewer": human["memberId"]}, 200)
			call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": true}, h, 200)
			for _, op := range []string{"pause", "remove", "revoke", "close"} {
				call(t, s, map[string]any{"op": op, "roomId": id, "paused": false, "memberId": human["memberId"]}, a, 409)
			}
			goalChange(t, s, id, a, "delete", nil, 409)
			call(t, s, map[string]any{"op": "pause", "roomId": id, "paused": false}, h, 200)
			restarted, err := New(s.directory, testOrigin, Options{})
			if err != nil {
				t.Fatal(err)
			}
			view := call(t, restarted, map[string]any{"op": "read", "roomId": id}, a, 200)
			if view["goal"].(map[string]any)["createdBy"] != ai["memberId"] {
				t.Fatal("AI-created goal must survive reload after creator departure")
			}
			goalChange(t, restarted, id, h, "delete", nil, 200)
			call(t, restarted, map[string]any{"op": "revoke", "roomId": id}, h, 200)
			call(t, restarted, map[string]any{"op": "preview", "roomId": id, "invite": invite}, "", 403)
			call(t, restarted, map[string]any{"op": "remove", "roomId": id, "memberId": human["memberId"]}, a, 200)
			call(t, restarted, map[string]any{"op": "close", "roomId": id}, a, 200)
			call(t, restarted, map[string]any{"op": "read", "roomId": id}, a, 410)
		})
	}
}
