package remote

import (
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "strings"
 "testing"
 "time"
)
func visitorTestProof(t *testing.T,key *ecdsa.PrivateKey,room,id,nonce,name string)*visitorProof{t.Helper();public:=roomKeyID(key);signature,err:=roomSign(key,"cafe-visitor-v1",room,id,nonce,roomDigest(name),public);if err!=nil{t.Fatal(err)};return &visitorProof{PublicKey:public,Signature:signature}}
func TestVisitorIdentityProofBindsConnectionRoomAndNickname(t *testing.T){
 key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);roomKey,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);room:=roomKeyID(roomKey);id,_:=NewToken();nonce,_:=NewToken();p:=Identity{ID:id,UserID:"guest-"+id,Name:"Guest",Role:"operator",Room:"main"};name:="拿铁 <&>";proof:=visitorTestProof(t,key,room,id,nonce,name)
 identity,err:=verifiedRoomVisitor(p,room,nonce,name,proof);if err!=nil||!identity.Verified||!strings.HasPrefix(identity.Name,name+"#")||len(identity.UserID)!=32{t.Fatal("valid nickname proof failed",err)}
 for _,mutation:=range []string{"id","nonce","room","name","key"}{q:=p;n,r,label,pr:=nonce,room,name,*proof;switch mutation{case "id":q.ID,_=NewToken();case "nonce":n,_=NewToken();case "room":r=roomKeyID(key);case "name":label+="x";case "key":pr.PublicKey=room};if _,e:=verifiedRoomVisitor(q,r,n,label,&pr);e==nil{t.Fatal("unbound proof",mutation)}}
 for _,invalid:=range []string{""," name","x#id","x\n","x\u202e",strings.Repeat("字",25)}{if visitorNicknameValid(invalid){t.Fatal("invalid nickname accepted")}}
 nextID,_:=NewToken();next:=p;next.ID=nextID;updated,err:=verifiedRoomVisitor(next,room,nonce,"美式",visitorTestProof(t,key,room,nextID,nonce,"美式"));if err!=nil||updated.UserID!=identity.UserID{t.Fatal("nickname change replaced identity")}
}
func TestVerifiedVisitorRefreshRetainsOnlyExistingApproval(t *testing.T){
 for _,end:=range []string{"resume","revoke","policy","password","expire"}{t.Run(end,func(t *testing.T){
  c,now,a,b:=controlPeers(t);a.Verified=true;a.UserID="visitor-stable";c.Leave(a.ID);c.Join(a);c.SetRoomPolicy("main",true);q:=application(t,c,a,"pi-a");if c.Decide("main",q.ID,true)!=""{t.Fatal("approve")};c.Leave(a.ID)
  if c.CanWrite(a,"pi-a")!="NOT_CONNECTED"{t.Fatal("offline write")};_,leases:=c.LocalControl("main");if len(leases)!=1{t.Fatal("owner cannot revoke offline grant")};if len(c.Snapshot(b).Leases)!=0{t.Fatal("offline holder published as live member")}
  impostor:=b;impostor.ID="impostor";impostor.Name=a.Name;impostor.Verified=true;c.Join(impostor);if c.CanWrite(impostor,"pi-a")!="CONTROL_REQUIRED"{t.Fatal("same nickname stole approval")}
  switch end{case "revoke":if c.Revoke("main","pi-a",q.ID)!=""{t.Fatal("revoke")};case "policy":c.SetRoomPolicy("main",false);c.SetRoomPolicy("main",true);case "password":c.ForgetRoomApprovals("main");case "expire":*now=now.Add(visitorReconnectGrace+time.Second);c.Expire()}
  a.ID="new-connection";a.Name="updated#fixedid";c.Join(a)
  want:="CONTROL_REQUIRED";if end=="resume"{want=""};if got:=c.CanWrite(a,"pi-a");got!=want{t.Fatal(end,got)};if c.CanWrite(a,"pi-b")!="CONTROL_REQUIRED"{t.Fatal("cross-instance grant")}
 })}
}
func TestVerifiedVisitorRealRTCRefreshAndRevocation(t *testing.T){
 f:=roomFixture(t,false);revision:=enableApproval(t,f.agent);key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader)
 login:=func(r *roomBrowser,name string)map[string]any{r.send(map[string]any{"type":"room.auth","id":r.b.opened.ID,"nonce":r.nonce,"password":"123456","nickname":name,"visitor":visitorTestProof(t,key,r.key,r.b.opened.ID,r.nonce,name)});info:=r.receive("room.authenticated");r.hello();return info}
 r:=connectRoom(t,f,false);first:=login(r,"拿铁");r.send(control("request","pi-a","acquire",false));r.receive("remote.result");q:=pendingFor(t,f.agent,r.b.opened.ID)
 if localControlCall(t,f.agent,controlBody("approve",map[string]any{"revision":revision,"applicationId":q.ID}),nil).Code!=200{t.Fatal("owner approval failed")}
 r.pc.Close();eventually(t,func()bool{f.agent.control.mu.Lock();defer f.agent.control.mu.Unlock();_,present:=f.agent.control.peers[r.b.opened.ID];return !present})
 second:=connectRoom(t,f,false);info:=login(second,"拿铁");if first["userId"]!=info["userId"]||first["visitorName"]!=info["visitorName"]||first["id"]==info["id"]{t.Fatal("refresh did not retain stable identity")}
 second.send(prompt("after-refresh","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1})
 if localControlCall(t,f.agent,controlBody("revoke",map[string]any{"revision":revision,"hostId":"pi-a","applicationId":q.ID}),nil).Code!=200{t.Fatal("revoke resumed grant")};second.send(prompt("after-revoke","pi-a"));if second.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("revoked resumed identity wrote")}
}
