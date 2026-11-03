package protocol

import (
	"reflect"
	"testing"
)

func TestAgentCapabilitiesCodecAndReducer(t *testing.T) {
	f := fixtureRead(t, "../parts/ordered.json").(Object)
	s := f["initial"].(Object)
	s["agent"] = Object{"name": "Codex ACP", "modelControl": false, "deliveryControl": false, "privateKey": "drop"}
	b, err := EncodeWire(Object{"type": "snapshot", "snapshot": s})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeWire(b)
	if err != nil {
		t.Fatal(err)
	}
	expected := Object{"name": "Codex ACP", "modelControl": false, "deliveryControl": false}
	if !reflect.DeepEqual(decoded["snapshot"].(Object)["agent"], expected) {
		t.Fatal("agent metadata not canonical")
	}
	events := f["events"].([]any)
	next, err := ApplyEvent(decoded["snapshot"].(Object), events[0].(Object))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next["agent"], expected) {
		t.Fatal("agent metadata lost on event")
	}
	s["agent"] = Object{"name": "bad", "modelControl": "false", "deliveryControl": false}
	raw, _ := stringify(Object{"type": "snapshot", "snapshot": s})
	if _, err := DecodeWire(raw); err == nil {
		t.Fatal("accepted invalid agent capabilities")
	}
}
