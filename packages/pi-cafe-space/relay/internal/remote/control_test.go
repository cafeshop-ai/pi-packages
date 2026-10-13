package remote

import (
	"testing"
	"time"
)

func TestControlLeaseAndRoomIsolation(t *testing.T) {
	now:=time.Unix(100,0);c:=newCoordinator(func()time.Time{return now})
	a:=Identity{ID:"a",UserID:"alice",Name:"Alice",Room:"main",Role:"operator"}
	b:=Identity{ID:"b",UserID:"bob",Name:"Bob",Room:"main",Role:"operator"}
	v:=Identity{ID:"v",UserID:"viewer",Name:"Viewer",Room:"main",Role:"viewer"}
	admin:=Identity{ID:"admin",UserID:"owner",Name:"Owner",Room:"main",Role:"admin"}
	other:=Identity{ID:"other",UserID:"other",Name:"Other",Room:"secret",Role:"admin"}
	for _,p:=range []Identity{a,b,v,admin,other}{if !c.Join(p){t.Fatal("join failed")}}
	if code:=c.Change(v,"pi-a","acquire",false);code!="READ_ONLY"{t.Fatal(code)}
	if code:=c.CanWrite(a,"pi-a");code!="CONTROL_REQUIRED"{t.Fatal(code)}
	if code:=c.Change(a,"pi-a","acquire",false);code!=""{t.Fatal(code)}
	if code:=c.CanWrite(a,"pi-a");code!=""{t.Fatal(code)}
	if code:=c.Change(b,"pi-a","acquire",false);code!="CONTROL_BUSY"{t.Fatal(code)}
	if code:=c.Change(b,"pi-a","acquire",true);code!="FORBIDDEN"{t.Fatal(code)}
	if code:=c.Change(other,"pi-a","acquire",false);code!=""{t.Fatal(code)}
	if code:=c.Change(admin,"pi-a","acquire",true);code!=""{t.Fatal(code)}
	if code:=c.CanWrite(a,"pi-a");code!="CONTROL_REQUIRED"{t.Fatal(code)}
	if len(c.Snapshot(a).Members)!=4{t.Fatal("cross-room presence leak")}
	now=now.Add(31*time.Second);if code:=c.CanWrite(admin,"pi-a");code!="CONTROL_REQUIRED"{t.Fatal("expired lease",code)}
	if !c.Expire(){t.Fatal("expired controls not removed")}
	if code:=c.Change(b,"pi-a","acquire",false);code!=""{t.Fatal(code)}
	c.Leave("b");if code:=c.Change(a,"pi-a","acquire",false);code!=""{t.Fatal("disconnect did not release",code)}
	if code:=c.Change(a,"pi-a","renew",false);code!=""{t.Fatal(code)}
	if code:=c.Change(a,"pi-a","release",false);code!=""{t.Fatal(code)}
	if code:=c.CanWrite(a,"pi-a");code!="CONTROL_REQUIRED"{t.Fatal(code)}
}
func TestControlIdentityCannotBeReused(t *testing.T){
	c:=newCoordinator(time.Now);p:=Identity{ID:"same",UserID:"alice",Name:"Alice",Room:"main",Role:"operator"}
	if !c.Join(p)||c.Join(p){t.Fatal("duplicate identity replaced live peer")}
	c.Leave(p.ID);if code:=c.Change(p,"pi-a","acquire",false);code!="NOT_CONNECTED"{t.Fatal(code)}
}
