// Package webui serves only validated, explicitly listed application assets.
// There is no production filesystem/webRoot fallback. R16 supplies embedded FS.
package webui

import (
	"errors"
	"io"
	"io/fs"
	"path"
	"strings"
)

const MaxFileBytes = 4 * 1024 * 1024
const MaxTotalBytes = 16 * 1024 * 1024
const MaxFiles = 256

type asset struct {
	body        []byte
	contentType string
}
type Assets struct{ entries map[string]asset }

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".webmanifest":
		return "application/manifest+json; charset=utf-8"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".woff2":
		return "font/woff2"
	}
	return ""
}
func allowed(name string) bool {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\%:#?\x00") || path.Clean(name) != name {
		return false
	}
	if name == "index.html" || name == "icon.svg" || name == "manifest.webmanifest" {
		return true
	}
	return strings.HasPrefix(name, "assets/") && strings.Count(name, "/") == 1 && !strings.HasPrefix(path.Base(name), ".") && contentType(name) != "" && path.Ext(name) != ".html" && path.Ext(name) != ".webmanifest"
}
func Load(source fs.FS, names []string) (*Assets, error) {
	if source == nil || len(names) == 0 || len(names) > MaxFiles {
		return nil, errors.New("invalid asset manifest size")
	}
	a := &Assets{entries: map[string]asset{}}
	total := int64(0)
	for _, name := range names {
		if !allowed(name) {
			return nil, errors.New("asset path or extension is not allowed")
		}
		if _, exists := a.entries["/"+name]; exists {
			return nil, errors.New("duplicate asset")
		}
		file, e := source.Open(name)
		if e != nil {
			return nil, errors.New("asset missing")
		}
		info, e := file.Stat()
		if e != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > MaxFileBytes {
			file.Close()
			return nil, errors.New("asset must be a bounded regular file")
		}
		body, e := io.ReadAll(io.LimitReader(file, MaxFileBytes+1))
		closeErr := file.Close()
		if e != nil || closeErr != nil || len(body) > MaxFileBytes || int64(len(body)) != info.Size() {
			return nil, errors.New("asset read failed or changed")
		}
		total += int64(len(body))
		if total > MaxTotalBytes {
			return nil, errors.New("assets exceed total budget")
		}
		a.entries["/"+name] = asset{body: body, contentType: contentType(name)}
	}
	index, ok := a.entries["/index.html"]
	if !ok || len(index.body) == 0 {
		return nil, errors.New("index.html required")
	}
	a.entries["/"] = index
	return a, nil
}
func (a *Assets) Get(url string) ([]byte, string, bool) {
	if a == nil {
		return nil, "", false
	}
	v, ok := a.entries[url]
	if !ok {
		return nil, "", false
	}
	return append([]byte(nil), v.body...), v.contentType, true
}
