package agentdist

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func manifestFor(t *testing.T, body []byte, change func(map[string]any)) []byte {
	t.Helper()
	sum := sha256.Sum256(body)
	m := map[string]any{"format": manifestFormat, "name": Name, "version": "0.1.0", "protocol": "1.1", "bytes": len(body), "sha256": hex.EncodeToString(sum[:])}
	if change != nil {
		change(m)
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLoadAcceptsOnlyTheBundleItsManifestNames(t *testing.T) {
	body := []byte("#!/usr/bin/env node\nconsole.log(1)\n")
	got, err := Load(body, manifestFor(t, body, nil))
	if err != nil || got.Version != "0.1.0" || got.Protocol != "1.1" || string(got.Body) != string(body) {
		t.Fatalf("Load = %+v, %v", got, err)
	}
	for name, change := range map[string]func(map[string]any){
		"format":   func(m map[string]any) { m["format"] = "other" },
		"name":     func(m map[string]any) { m["name"] = "other.mjs" },
		"version":  func(m map[string]any) { m["version"] = "bad version" },
		"protocol": func(m map[string]any) { m["protocol"] = "" },
		"bytes":    func(m map[string]any) { m["bytes"] = len(body) + 1 },
		"sha256":   func(m map[string]any) { m["sha256"] = "00" + m["sha256"].(string)[2:] },
	} {
		if _, err := Load(body, manifestFor(t, body, change)); err == nil {
			t.Errorf("a changed %s was accepted", name)
		}
	}
	if _, err := Load(append([]byte("x"), body...), manifestFor(t, body, nil)); err == nil {
		t.Error("a changed body was accepted")
	}
	if _, err := Load(nil, manifestFor(t, nil, nil)); err == nil {
		t.Error("an empty bundle was accepted")
	}
}
