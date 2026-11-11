package agentdist

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
)

func digest(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }

func manifestFor(t *testing.T, files map[string][]byte, change func(map[string]any)) []byte {
	t.Helper()
	entries := []any{}
	for _, name := range []string{Listener, PiBridge} {
		body, ok := files[name]
		if !ok {
			continue
		}
		e := map[string]any{"name": name, "bytes": len(body), "sha256": digest(body)}
		if name == Listener {
			e["protocol"] = "1.1"
		}
		entries = append(entries, e)
	}
	m := map[string]any{"format": manifestFormat, "version": "0.1.0", "files": entries}
	if change != nil {
		change(m)
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func reader(files map[string][]byte) func(string) ([]byte, error) {
	return func(name string) ([]byte, error) {
		if body, ok := files[name]; ok {
			return body, nil
		}
		return nil, errors.New("missing")
	}
}

func TestLoadAcceptsOnlyTheFilesItsManifestNames(t *testing.T) {
	files := map[string][]byte{Listener: []byte("#!/usr/bin/env node\n"), PiBridge: []byte("export default function () {}\n")}
	b, err := Load(manifestFor(t, files, nil), reader(files))
	if err != nil || b.Version != "0.1.0" || b.Get(Listener).Protocol != "1.1" || string(b.Get(PiBridge).Body) != string(files[PiBridge]) || b.Get("other") != nil {
		t.Fatalf("Load = %+v, %v", b, err)
	}
	if (*Bundle)(nil).Get(Listener) != nil {
		t.Fatal("a missing bundle has no files")
	}
	entry := func(i int, key string, value any) func(map[string]any) {
		return func(m map[string]any) { m["files"].([]any)[i].(map[string]any)[key] = value }
	}
	for name, change := range map[string]func(map[string]any){
		"format":            func(m map[string]any) { m["format"] = "pi-cafe-space-agent-v1" },
		"version":           func(m map[string]any) { m["version"] = "bad version" },
		"no files":          func(m map[string]any) { m["files"] = []any{} },
		"unknown name":      entry(0, "name", "other.mjs"),
		"listener protocol": entry(0, "protocol", ""),
		"bridge protocol":   entry(1, "protocol", "1.1"),
		"bytes":             entry(1, "bytes", len(files[PiBridge])+1),
		"sha256":            entry(0, "sha256", digest([]byte("other"))),
		"duplicate":         func(m map[string]any) { m["files"] = append(m["files"].([]any), m["files"].([]any)[0]) },
	} {
		if _, err := Load(manifestFor(t, files, change), reader(files)); err == nil {
			t.Errorf("a changed %s was accepted", name)
		}
	}
	changed := map[string][]byte{Listener: files[Listener], PiBridge: []byte("changed")}
	if _, err := Load(manifestFor(t, files, nil), reader(changed)); err == nil {
		t.Error("a changed file was accepted")
	}
	if _, err := Load(manifestFor(t, files, nil), reader(map[string][]byte{Listener: files[Listener]})); err == nil {
		t.Error("a missing file was accepted")
	}
}
