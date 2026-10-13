//go:build webembed

package webui

import (
	"embed"
	"io/fs"
)

//go:embed assets
var embedded embed.FS

func Embedded() (*Assets, string, error) {
	source, err := fs.Sub(embedded, "assets")
	if err != nil {
		return nil, "", err
	}
	return loadManifest(source)
}
