package webui

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestAssetsAreExplicitImmutableAndBounded(t *testing.T) {
	source := fstest.MapFS{"index.html": {Data: []byte("<html></html>")}, "assets/app-123.js": {Data: []byte("export {};")}, "private.map": {Data: []byte("secret")}}
	a, e := Load(source, []string{"index.html", "assets/app-123.js"})
	if e != nil {
		t.Fatal(e)
	}
	source["index.html"].Data[0] = 'X'
	body, mime, ok := a.Get("/")
	if !ok || string(body) != "<html></html>" || mime != "text/html; charset=utf-8" {
		t.Fatal("invalid root")
	}
	body[0] = 'Y'
	body, _, _ = a.Get("/")
	if string(body) != "<html></html>" {
		t.Fatal("mutable bytes escaped")
	}
	for _, path := range []string{"/private.map", "/assets/../index.html", "/INDEX.HTML", "/%69ndex.html", "//index.html", "/assets/", "/.env", "/asset-manifest.json"} {
		if _, _, ok := a.Get(path); ok {
			t.Errorf("served %s", path)
		}
	}
	for _, name := range []string{"../index.html", ".env", "private.map", "dir/index.html", "a\\b.js", "assets/foo.json"} {
		if _, e := Load(source, []string{name}); e == nil {
			t.Errorf("allowed unsafe asset %s", name)
		}
	}
}
func TestAssetBudgetsAndSymlink(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files fstest.MapFS
		names []string
	}{
		{"missing", fstest.MapFS{}, []string{"index.html"}},
		{"over-file", fstest.MapFS{"index.html": {Data: []byte(strings.Repeat("x", 4*1024*1024+1))}}, []string{"index.html"}},
		{"symlink", fstest.MapFS{"index.html": {Mode: fs.ModeSymlink, Data: []byte("other")}}, []string{"index.html"}},
		{"duplicate", fstest.MapFS{"index.html": {Data: []byte("x")}}, []string{"index.html", "index.html"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, e := Load(tc.files, tc.names); e == nil {
				t.Fatal("accepted invalid assets")
			}
		})
	}
	files := fstest.MapFS{}
	names := []string{}
	for _, name := range []string{"index.html", "assets/a.js", "assets/b.js", "assets/c.js", "assets/d.js"} {
		files[name] = &fstest.MapFile{Data: make([]byte, 4*1024*1024)}
		names = append(names, name)
	}
	if _, e := Load(files, names); e == nil {
		t.Fatal("accepted total >16MiB")
	}
	if _, e := Load(files, names[:4]); e != nil {
		t.Fatal(e)
	}
}
