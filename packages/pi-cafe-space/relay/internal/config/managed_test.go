package config

import "testing"

func TestManagedAdmission(t *testing.T) {
	strong := map[string]string{"PI_COLLAB_MANAGED_CONFIG": "C:/owned/config.json", "PI_COLLAB_HOST_TOKEN": "02fc4e71-8d49-4a60-b9d6-55e1c820c9d7", "PI_COLLAB_CLIENT_TOKEN": "637c92e4-e17f-4c68-a92b-73c1af02d98a"}
	for _, change := range []map[string]string{{"PI_COLLAB_HOST_TOKEN": ""}, {"PI_COLLAB_CLIENT_TOKEN": strong["PI_COLLAB_HOST_TOKEN"]}, {"PI_COLLAB_HOST_TOKEN": "replace-with-a-long-random-host-token"}, {"PI_COLLAB_HOST": "0.0.0.0"}, {"PI_COLLAB_MANAGED_CONFIG": "C:/invalid\x00"}} {
		env := map[string]string{}
		for k, v := range strong {
			env[k] = v
		}
		for k, v := range change {
			env[k] = v
		}
		if _, err := Parse(env); err == nil {
			t.Fatal("unsafe managed config accepted")
		}
	}
	if c, err := Parse(strong); err != nil || c.ManagedConfig != strong["PI_COLLAB_MANAGED_CONFIG"] {
		t.Fatal(c, err)
	}
}
