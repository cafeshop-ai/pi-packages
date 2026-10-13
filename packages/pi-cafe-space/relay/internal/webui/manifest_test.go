package webui

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"testing/fstest"
)

func TestManifest(t *testing.T) {
	body := []byte("<!doctype html><p>owned</p>")
	hash := sha256.Sum256(body)
	m := assetManifest{Format: "pi-cafe-space-assets-v1", Entries: []manifestEntry{{Name: "index.html", Bytes: int64(len(body)), SHA256: hex.EncodeToString(hash[:])}}}
	encoded, _ := json.Marshal(m.Entries)
	hash = sha256.Sum256(encoded)
	m.Digest = hex.EncodeToString(hash[:])
	raw, _ := json.Marshal(m)
	files := fstest.MapFS{"index.html": &fstest.MapFile{Data: body}, "asset-manifest.json": &fstest.MapFile{Data: raw}}
	assets, digest, err := loadManifest(files)
	if err != nil || digest != m.Digest {
		t.Fatal(err, digest)
	}
	if _, _, ok := assets.Get("/asset-manifest.json"); ok {
		t.Fatal("private manifest served")
	}
	files["extra.map"] = &fstest.MapFile{Data: []byte("bad")}
	if _, _, err := loadManifest(files); err == nil {
		t.Fatal("extra file accepted")
	}
	delete(files, "extra.map")
	files["index.html"] = &fstest.MapFile{Data: []byte("changed")}
	if _, _, err := loadManifest(files); err == nil {
		t.Fatal("changed bytes accepted")
	}
	delete(files, "asset-manifest.json")
	if _, _, err := loadManifest(files); err == nil {
		t.Fatal("missing manifest accepted")
	}
}
