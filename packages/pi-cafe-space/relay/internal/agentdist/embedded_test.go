//go:build webembed

package agentdist

import (
	"bytes"
	"testing"
)

func TestEmbeddedFilesAreTheVerifiedBundles(t *testing.T) {
	b, err := Embedded()
	if err != nil || b == nil {
		t.Fatalf("Embedded = %v, %v", b, err)
	}
	if l := b.Get(Listener); l == nil || !bytes.HasPrefix(l.Body, []byte("#!/usr/bin/env node\n")) || !bytes.Contains(l.Body, []byte("space-agent")) {
		t.Fatal("the embedded listener is not the space-agent bundle")
	}
	if p := b.Get(PiBridge); p == nil || !bytes.Contains(p.Body, []byte("export")) || !bytes.Contains(p.Body, []byte("cafe_room_status")) {
		t.Fatal("the embedded Pi bridge is not the cafe collab extension bundle")
	}
}
