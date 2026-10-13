package webui

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"regexp"
)

type manifestEntry struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type assetManifest struct {
	Format  string          `json:"format"`
	Digest  string          `json:"digest"`
	Entries []manifestEntry `json:"entries"`
}

var hashedAsset = regexp.MustCompile(`^assets/[a-zA-Z0-9][a-zA-Z0-9_.-]*-[a-zA-Z0-9_-]{8,}\.(js|css|svg|png|webp|woff2)$`)

func loadManifest(source fs.FS) (*Assets, string, error) {
	fail := func() (*Assets, string, error) { return nil, "", errors.New("invalid embedded asset manifest") }
	file, err := source.Open("asset-manifest.json")
	if err != nil {
		return fail()
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 {
		return fail()
	}
	var manifest assetManifest
	if json.Unmarshal(data, &manifest) != nil || manifest.Format != "pi-cafe-space-assets-v1" || len(manifest.Entries) == 0 || len(manifest.Entries) > MaxFiles {
		return fail()
	}
	encoded, err := json.Marshal(manifest.Entries)
	if err != nil {
		return fail()
	}
	hash := sha256.Sum256(encoded)
	if hex.EncodeToString(hash[:]) != manifest.Digest {
		return fail()
	}
	names := make([]string, 0, len(manifest.Entries))
	seen := map[string]bool{"asset-manifest.json": true}
	for _, entry := range manifest.Entries {
		if seen[entry.Name] || (entry.Name != "index.html" && entry.Name != "icon.svg" && entry.Name != "manifest.webmanifest" && !hashedAsset.MatchString(entry.Name)) || entry.Bytes < 0 || entry.Bytes > MaxFileBytes {
			return fail()
		}
		seen[entry.Name] = true
		names = append(names, entry.Name)
	}
	assets, err := Load(source, names)
	if err != nil {
		return nil, "", err
	}
	for _, entry := range manifest.Entries {
		body, _, ok := assets.Get("/" + entry.Name)
		hash := sha256.Sum256(body)
		if !ok || int64(len(body)) != entry.Bytes || hex.EncodeToString(hash[:]) != entry.SHA256 {
			return fail()
		}
	}
	err = fs.WalkDir(source, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if name != "." && name != "assets" {
				return errors.New("unexpected embedded directory")
			}
			return nil
		}
		if !seen[name] || entry.Type()&fs.ModeSymlink != 0 {
			return errors.New("unexpected embedded file")
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	return assets, manifest.Digest, nil
}
