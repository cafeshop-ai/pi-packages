package service

import (
 "encoding/json"
 "os"
 "path/filepath"
 "strings"
 "testing"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/remote"
)
func TestManagedUserTokenRequiresValidatedRoomCapability(t *testing.T) {
 dir:=t.TempDir()
 room:=remote.Config{Mode:"device",PublicOrigin:"https://space.example",CloudURL:"wss://space.example/room/host",RoomIdentityFile:filepath.Join(dir,"identity","room.json"),DeviceName:"Office",Rooms:[]string{"main"},MaxRole:"operator",EnableWebRTC:true}
 legacy:=remote.Config{Mode:"device",CloudURL:"wss://space.example/remote/agent",DeviceID:"office",DeviceToken:strings.Repeat("a",43),Rooms:[]string{"main"},MaxRole:"operator",EnableWebRTC:true}
 for _,test:=range []struct{name string;cfg *remote.Config}{{"no remote",nil},{"unapproved room",&room},{"legacy device",&legacy}} {
  t.Run(test.name,func(t *testing.T){c:=config.Config{Host:"127.0.0.1",Port:37891,HostToken:strings.Repeat("b",43),ClientToken:"MyRoom42",ManagedConfig:filepath.Join(dir,"must-not-be-opened.json"),ManagedRoomCredentials:true}
   if test.cfg!=nil{b,_:=json.Marshal(test.cfg);c.RemoteConfig=filepath.Join(dir,strings.ReplaceAll(test.name," ","-")+".json");if err:=os.WriteFile(c.RemoteConfig,b,0600);err!=nil{t.Fatal(err)}}
   s,err:=New(c,Options{});if s!=nil||err==nil||!strings.Contains(err.Error(),"explicitly enabled office room"){t.Fatalf("room capability not checked before manager: %v",err)}
  })
 }
}
