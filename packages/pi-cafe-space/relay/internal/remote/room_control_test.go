package remote

import (
 "os"
 "path/filepath"
 "sync"
 "testing"
 "time"
)
func controlPeers(t *testing.T)(*coordinator,*time.Time,Identity,Identity){
 t.Helper();now:=time.Unix(1000,0);c:=newCoordinator(func()time.Time{return now});c.SetRoomPolicy("main",false)
 a:=Identity{ID:"a",UserID:"alice",Name:"Alice",Room:"main",Role:"operator"};b:=Identity{ID:"b",UserID:"bob",Name:"Bob",Room:"main",Role:"operator"}
 c.Join(a);c.Join(b);return c,&now,a,b
}
func application(t *testing.T,c *coordinator,p Identity,host string)ControlApplication{t.Helper();if code:=c.Change(p,host,"acquire",false);code!=""{t.Fatal(code)};for _,q:=range c.Snapshot(p).Applications{if q.HostID==host&&q.State=="pending"{return q}};t.Fatal("missing application");return ControlApplication{}}
func TestRoomControlDisabledIsDefaultButNotAnAuthenticationBypass(t *testing.T){
 c,_,a,b:=controlPeers(t);if c.CanWrite(a,"pi-a")!=""||c.CanWrite(b,"pi-a")!=""{t.Fatal("disabled policy still requires lease")}
 if c.Snapshot(a).ControlPolicy!="disabled"||len(c.Snapshot(a).Leases)!=0{t.Fatal("wrong disabled presence")}
 if c.Change(a,"pi-a","acquire",false)!="CONTROL_DISABLED"{t.Fatal("disabled request created a lease")}
 viewer:=Identity{ID:"viewer",Room:"main",Role:"viewer"};c.Join(viewer);if c.CanWrite(viewer,"pi-a")!="READ_ONLY"{t.Fatal("viewer upgraded")};c.Leave(a.ID);if c.CanWrite(a,"pi-a")!="NOT_CONNECTED"{t.Fatal("disconnected identity can write")}
}
func TestRoomControlRequiresOwnerDecisionAndRejectsRemoteForce(t *testing.T){
 c,now,a,b:=controlPeers(t);c.SetRoomPolicy("main",true);q:=application(t,c,a,"pi-a")
 if c.CanWrite(a,"pi-a")!="CONTROL_REQUIRED"||len(c.Snapshot(a).Leases)!=0{t.Fatal("request automatically granted")}
 if len(c.Snapshot(b).Applications)!=0{t.Fatal("request privacy")}
 again:=application(t,c,a,"pi-a");if again.ID!=q.ID{t.Fatal("duplicate request not coalesced")}
 admin:=Identity{ID:"admin",UserID:"admin",Name:"Admin",Room:"main",Role:"admin"};c.Join(admin);if c.Change(admin,"pi-a","acquire",true)!="FORBIDDEN"{t.Fatal("remote admin bypassed owner")}
 if c.Decide("other",q.ID,true)!="CONTROL_REQUEST_GONE"&&c.Decide("other",q.ID,true)!="CONTROL_DISABLED"{t.Fatal("cross-room grant")}
 if c.Decide("main",q.ID,true)!=""||c.CanWrite(a,"pi-a")!=""{t.Fatal("owner approval failed")};if c.CanWrite(a,"pi-b")!="CONTROL_REQUIRED"{t.Fatal("cross-instance approval")}
 if c.Decide("main",q.ID,true)!="CONTROL_REQUEST_GONE"{t.Fatal("approval replay accepted")}
 *now=now.Add(15*time.Second);if c.Change(a,"pi-a","renew",false)!=""{t.Fatal("approved holder cannot renew")}
 if c.Revoke("main","pi-a","wrong-id")!="CONTROL_REQUEST_GONE"{t.Fatal("stale revoke succeeded")};if c.Revoke("main","pi-a",q.ID)!=""||c.CanWrite(a,"pi-a")!="CONTROL_REQUIRED"{t.Fatal("revoke failed")}
 if c.Change(a,"pi-a","renew",false)!="CONTROL_REQUIRED"{t.Fatal("revoked approval renewed")}
}
func TestRoomControlDenialCancellationTimeoutAndDisconnect(t *testing.T){
 c,now,a,b:=controlPeers(t);c.SetRoomPolicy("main",true);q:=application(t,c,a,"pi-a");if c.Decide("main",q.ID,false)!=""{t.Fatal("deny")};if c.CanWrite(a,"pi-a")!="CONTROL_REQUIRED"{t.Fatal("denial granted")}
 q=application(t,c,a,"pi-a");if c.CancelApplication(b,q.ID)!="CONTROL_REQUEST_GONE"{t.Fatal("another peer cancelled")};if c.CancelApplication(a,q.ID)!=""{t.Fatal("cancel")};if c.Decide("main",q.ID,true)!="CONTROL_REQUEST_GONE"{t.Fatal("cancelled request approved")}
 q=application(t,c,a,"pi-a");*now=now.Add(91*time.Second);if c.Decide("main",q.ID,true)!="CONTROL_REQUEST_EXPIRED"{t.Fatal("expired request approved")}
 q=application(t,c,a,"pi-a");c.Leave(a.ID);if c.Decide("main",q.ID,true)!="CONTROL_REQUEST_GONE"{t.Fatal("disconnected request approved")}
 c.Join(a);q=application(t,c,a,"pi-a");c.Decide("main",q.ID,true);*now=now.Add(31*time.Second);if !c.Expire()||c.CanWrite(a,"pi-a")!="CONTROL_REQUIRED"{t.Fatal("lease not expired")}
 if c.Change(a,"pi-a","renew",false)!="CONTROL_REQUIRED"{t.Fatal("expired grant reactivated")}
 q=application(t,c,a,"pi-a");c.SetRoomPolicy("main",false);if c.CanWrite(a,"pi-a")!=""||len(c.Snapshot(a).Applications)>0{t.Fatal("disable did not clear state")};c.SetRoomPolicy("main",true);if c.CanWrite(a,"pi-a")!="CONTROL_REQUIRED"||c.Decide("main",q.ID,true)!="CONTROL_REQUEST_GONE"{t.Fatal("old consent survived re-enable")}
}
func TestRoomControlConcurrentOwnerDecisionsDoNotReplaceOtherHolder(t *testing.T){
 c,_,a,b:=controlPeers(t);c.SetRoomPolicy("main",true);qa:=application(t,c,a,"pi-a");qb:=application(t,c,b,"pi-a");var wg sync.WaitGroup;results:=make(chan string,2)
 for _,q:=range []ControlApplication{qa,qb}{wg.Add(1);go func(q ControlApplication){defer wg.Done();results<-c.Decide("main",q.ID,true)}(q)};wg.Wait();close(results);success:=0;busy:=0;for code:=range results{if code==""{success++}else if code=="CONTROL_BUSY"{busy++}else{t.Fatal(code)}};if success!=1||busy!=1{t.Fatal("concurrent approvals replaced holder")}
}
func TestRoomControlPersistsSeparatelyAndDoesNotResetCorruption(t *testing.T){
 path:=filepath.Join(t.TempDir(),"private","room.json");_,err:=loadRoomOwner(path,"123456");if err!=nil{t.Fatal(err)};identity,_:=os.ReadFile(path)
 settings,err:=loadRoomControlSettings(path);if err!=nil||settings.snapshot().Enabled{t.Fatal("not default off")};if _,err=os.Stat(path+".control.json");!os.IsNotExist(err){t.Fatal("read unexpectedly persisted defaults")}
 if settings.change(true,1)!=nil{t.Fatal("persist")};again,err:=loadRoomControlSettings(path);if err!=nil||!again.snapshot().Enabled||again.snapshot().Revision!=2{t.Fatal("restart lost settings")}
 if again.change(false,1)==nil{t.Fatal("stale policy write")};if again.change(false,2)!=nil{t.Fatal("disable")};after,_:=os.ReadFile(path);if string(identity)!=string(after){t.Fatal("identity or password changed")}
 if err=os.WriteFile(path+".control.json",[]byte(`{"version":1,"enabled":"bad","revision":3}`),0600);err!=nil{t.Fatal(err)};if _,err=loadRoomControlSettings(path);err==nil{t.Fatal("corrupt policy defaulted to open")}
}
