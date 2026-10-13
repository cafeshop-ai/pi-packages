package protocol

import (
	"reflect"
	"testing"
)

func TestPartsFixtures(t *testing.T) {
	for _, name := range []string{"codec.json", "reducer.json", "budget-reducer.json"} {
		for _, raw := range fixtureRead(t, "../parts/"+name).([]any) {
			f := expandFixture(t, raw, Object{}).(Object)
			t.Run(f["id"].(string), func(t *testing.T) {
				before, _ := stringify(f)
				expected := f["expected"].(Object)
				var got any
				var err error
				if f["operation"] == "decode" {
					input, e := stringify(f["inputTemplate"])
					if e != nil {
						t.Fatal(e)
					}
					got, err = DecodeWire(input)
				} else {
					got, err = ApplyEvent(f["snapshot"].(Object), f["envelope"].(Object))
				}
				after, _ := stringify(f)
				if string(before) != string(after) {
					t.Fatal("mutated input")
				}
				if expected["accepted"] == true {
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(got, expected["value"]) {
						t.Fatalf("parts value mismatch: got %.1000v want %.1000v", got, expected["value"])
					}
				} else if err == nil {
					t.Fatal("expected rejection")
				}
			})
		}
	}
}
func TestOrderedParts(t *testing.T) {
	f := fixtureRead(t, "../parts/ordered.json").(Object)
	s := f["initial"].(Object)
	for _, raw := range f["events"].([]any) {
		b, _ := stringify(raw)
		e, err := DecodeWire(b)
		if err != nil {
			t.Fatal(err)
		}
		before, _ := stringify(s)
		next, err := ApplyEvent(s, e)
		if err != nil {
			t.Fatal(err)
		}
		after, _ := stringify(s)
		if string(before) != string(after) {
			t.Fatal("mutated input")
		}
		s = next
	}
	if !reflect.DeepEqual(s, f["expectedFinal"]) {
		t.Fatal("ordered result mismatch")
	}
	encoded, err := EncodeWire(Object{"type": "snapshot", "hostId": "host-a", "snapshot": s})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeWire(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded["snapshot"], s) {
		t.Fatal("reconnect changed parts")
	}
}
