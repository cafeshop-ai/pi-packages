package hub

import "testing"

func TestInputAssistCapabilityFencesAndBusy(t *testing.T) {
	h, _, c, cf, host, hf := setupCommands(t)
	m := command("input", "run_command")
	m["payload"] = O{"name": "run_command", "command": "/review"}
	send(t, h, c, m)
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "INPUT_ASSIST_UNAVAILABLE" {
		t.Fatal(got)
	}
	s := snapshot("s", "session", 0)
	s["inputAssist"] = true
	for _, phase := range []string{"running", "waiting_local_ui", "idle"} {
		s["phase"] = phase
		s["hasPendingMessages"] = phase == "idle"
		send(t, h, host, O{"type": "snapshot", "snapshot": s})
		cf.drain()
		send(t, h, c, m)
		if got := cf.drain(); len(got) != 1 || got[0]["code"] != "SESSION_BUSY" {
			t.Fatal(got)
		}
	}
	s["hasPendingMessages"] = false
	send(t, h, host, O{"type": "snapshot", "snapshot": s})
	cf.drain()
	delete(m, "expectedCwd")
	send(t, h, c, m)
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "STALE_SESSION" {
		t.Fatal(got)
	}
	if len(hf.drain()) != 0 {
		t.Fatal("unsafe command was routed")
	}
	m["expectedCwd"] = "C:/test"
	send(t, h, c, m)
	routed := hf.drain()
	if len(routed) != 1 || routed[0]["payload"].(O)["command"] != "/review" {
		t.Fatal(routed)
	}
	send(t, h, c, m)
	if got := cf.drain(); len(got) != 1 || got[0]["code"] != "REQUEST_PENDING" {
		t.Fatal(got)
	}
	if len(hf.drain()) != 0 {
		t.Fatal("duplicate command was routed")
	}
}
