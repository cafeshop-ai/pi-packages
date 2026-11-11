//go:build webembed

package agentdist

import (
	"bytes"
	"testing"
)

func TestEmbeddedListenerIsTheVerifiedBundle(t *testing.T) {
	got, err := Embedded()
	if err != nil || got == nil {
		t.Fatalf("Embedded = %v, %v", got, err)
	}
	if !bytes.HasPrefix(got.Body, []byte("#!/usr/bin/env node\n")) || !bytes.Contains(got.Body, []byte("space-agent")) {
		t.Fatal("the embedded file is not the space-agent bundle")
	}
}
