package hub

import "testing"

func TestSessionControlsFenceCapabilityBusyAndHandoff(t *testing.T) {
	h, _, c, cf, host, hf := setupCommands(t)
	send(t, h, c, command("legacy", "new_session"))
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "SESSION_CONTROL_UNAVAILABLE" {
		t.Fatal(got)
	}
	if len(hf.drain()) != 0 {
		t.Fatal("sent new command to old extension")
	}
	s := snapshot("s", "session", 0)
	s["sessionControl"] = true
	for _, busy := range []string{"running", "waiting_local_ui", "queued"} {
		s["phase"] = busy
		s["hasPendingMessages"] = busy == "queued"
		if busy == "queued" {
			s["phase"] = "idle"
		}
		send(t, h, host, O{"type": "snapshot", "snapshot": s})
		cf.drain()
		send(t, h, c, command(busy, "new_session"))
		if got := cf.drain(); len(got) != 1 || got[0]["code"] != "SESSION_BUSY" {
			t.Fatal(got)
		}
	}
	s["phase"] = "idle"
	s["hasPendingMessages"] = false
	send(t, h, host, O{"type": "snapshot", "snapshot": s})
	cf.drain()
	missing := command("unfenced", "new_session")
	delete(missing, "expectedCwd")
	send(t, h, c, missing)
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "STALE_SESSION" {
		t.Fatal(got)
	}
	send(t, h, c, command("accepted", "new_session"))
	routed := hf.drain()
	if len(routed) != 1 {
		t.Fatal(routed)
	}
	id := routed[0]["relayRequestId"].(string)
	send(t, h, host, O{"type": "host_command_result", "relayRequestId": id, "status": "dispatched", "code": nil, "message": nil})
	h.Leave(host)
	h.Sync()
	results := 0
	for _, m := range cf.drain() {
		if m["type"] == "command_result" {
			results++
			if m["status"] != "dispatched" {
				t.Fatal(m)
			}
		}
	}
	if results != 1 {
		t.Fatal("handoff not acknowledged exactly once", results)
	}
}
