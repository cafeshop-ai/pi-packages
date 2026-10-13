package config

import (
 "crypto/rand"
 "encoding/base64"
 "path/filepath"
 "testing"
)
func TestManagedRoomAcceptsExplicitLocalSetupCredentials(t *testing.T) {
 b:=make([]byte,32);if _,err:=rand.Read(b);err!=nil{t.Fatal(err)}
 host:=base64.RawURLEncoding.EncodeToString(b)
 env:=map[string]string{"PI_COLLAB_HOST":"127.0.0.1","PI_COLLAB_HOST_TOKEN":host,"PI_COLLAB_CLIENT_TOKEN":"MyRoom42","PI_COLLAB_MANAGED_CONFIG":filepath.Join(t.TempDir(),"manager.json"),"PI_CAFE_REMOTE_CONFIG":filepath.Join(t.TempDir(),"room.json")}
 if _,err:=Parse(env);err!=nil{t.Fatalf("explicit room setup token rejected before room validation: %v",err)}
 for _,change:=range []map[string]string{{"PI_CAFE_REMOTE_CONFIG":""},{"PI_CAFE_REMOTE_CONFIG":"relative.json"},{"PI_COLLAB_HOST":"0.0.0.0"},{"PI_COLLAB_HOST_TOKEN":"MyRoom42"},{"PI_COLLAB_CLIENT_TOKEN":"short"},{"PI_COLLAB_CLIENT_TOKEN":host}} {
  clone:=map[string]string{};for k,v:=range env{clone[k]=v};for k,v:=range change{clone[k]=v};if _,err:=Parse(clone);err==nil{t.Fatal("unsafe managed setup admission")}
 }
}
