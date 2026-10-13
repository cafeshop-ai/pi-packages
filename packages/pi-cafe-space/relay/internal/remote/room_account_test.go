package remote

import(
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "sync/atomic"
 "testing"
 "time"
)
func accountTestSigner(t *testing.T)(*accountVerifier,func(accountClaims)string,*atomic.Int32){
 t.Helper();key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);var calls atomic.Int32;b64:=base64.RawURLEncoding.EncodeToString
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){calls.Add(1);if r.URL.Path!="/api/identity/jwks"{w.WriteHeader(404);return};w.Header().Set("Content-Type","application/json");json.NewEncoder(w).Encode(map[string]any{"keys":[]any{map[string]any{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"test-account","x":b64(key.X.FillBytes(make([]byte,32))),"y":b64(key.Y.FillBytes(make([]byte,32)))}}})}));t.Cleanup(server.Close)
 verifier:=newAccountVerifier(server.URL+"/api/identity");t.Cleanup(verifier.client.CloseIdleConnections)
 sign:=func(c accountClaims)string{head,_:=json.Marshal(map[string]any{"alg":"ES256","kid":"test-account","typ":"cafe-account+jwt"});body,_:=json.Marshal(c);input:=b64(head)+"."+b64(body);digest:=sha256.Sum256([]byte(input));r,s,e:=ecdsa.Sign(rand.Reader,key,digest[:]);if e!=nil{t.Fatal(e)};return input+"."+b64(append(r.FillBytes(make([]byte,32)),s.FillBytes(make([]byte,32))...))};return verifier,sign,&calls
}
func accountTestClaims(v *accountVerifier,room,id,nonce,pub string)accountClaims{sid,_:=NewToken();jti,_:=NewToken();sub:=roomDigest("synthetic-cafe-account");now:=time.Now().Unix();return accountClaims{Issuer:v.issuer,Audience:"cafe-space-room",Subject:sub,DisplayID:sub[:8],ID:jti,Issued:now,Expires:now+60,Name:"拿铁",Session:sid,RoomHash:roomDigest(room),Connection:id,Nonce:nonce,PublicKey:pub}}
func TestAccountAssertionStrictBindingAndSignature(t *testing.T){
 v,sign,_:=accountTestSigner(t);key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);room:=roomKeyID(key);id,_:=NewToken();nonce,_:=NewToken();pub:=roomKeyID(key);claims:=accountTestClaims(v,room,id,nonce,pub)
 if _,e:=v.verify(context.Background(),sign(claims),room,id,nonce,pub);e!=nil{t.Fatal(e)}
 for _,mutate:=range []func(*accountClaims){func(c *accountClaims){c.Issuer="https://evil.invalid"},func(c *accountClaims){c.Audience="main-admin"},func(c *accountClaims){c.Connection="wrong"},func(c *accountClaims){c.Nonce="wrong"},func(c *accountClaims){c.PublicKey="other"},func(c *accountClaims){c.RoomHash=roomDigest("other room")},func(c *accountClaims){c.Name="fake#id"},func(c *accountClaims){c.Expires=time.Now().Unix()-1},func(c *accountClaims){c.Expires=c.Issued+3600},func(c *accountClaims){c.Issued=time.Now().Unix()+30},func(c *accountClaims){c.DisplayID="deadbeef"}}{
  bad:=claims;mutate(&bad);if _,e:=v.verify(context.Background(),sign(bad),room,id,nonce,pub);e==nil{t.Fatal("invalid claim accepted")}
 }
 parts:=strings.Split(sign(claims),".");parts[1]=base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"forged"}`));if _,e:=v.verify(context.Background(),strings.Join(parts,"."),room,id,nonce,pub);e==nil{t.Fatal("forged account accepted")}
 var none *accountVerifier;if _,e:=none.verify(context.Background(),sign(claims),room,id,nonce,pub);e==nil{t.Fatal("unconfigured account provider accepted")}
}
func TestAccountNeverBypassesRoomPasswordOrRole(t *testing.T){
 f:=roomFixture(t,false);v,sign,calls:=accountTestSigner(t);f.agent.accounts=v
 login:=func(password string)(*roomBrowser,map[string]any,accountClaims){r:=connectRoom(t,f,false);key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);proof:=visitorTestProof(t,key,r.key,r.b.opened.ID,r.nonce,"拿铁");c:=accountTestClaims(v,r.key,r.b.opened.ID,r.nonce,proof.PublicKey);r.send(map[string]any{"type":"room.auth","id":r.b.opened.ID,"nonce":r.nonce,"password":password,"nickname":"拿铁","visitor":proof,"account":sign(c)});kind:="room.authenticated";if password!="123456"{kind="room.denied"};return r,r.receive(kind),c}
 _,denied,_:=login("wrong-password");if denied["code"]!="ROOM_PASSWORD_REJECTED"||calls.Load()!=0{t.Fatal("account login bypassed room password")}
 r,info,_:=login("123456");if info["role"]!="operator"||info["identityKind"]!="account"||!strings.HasPrefix(info["visitorName"].(string),"拿铁#")||!strings.HasPrefix(info["userId"].(string),"account-"){t.Fatal("incorrect account role or label")};r.hello()
 r.send(prompt("account-default-off","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1});enableApproval(t,f.agent);r.send(prompt("account-needs-owner","pi-a"));if r.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("account bypassed owner approval")}
 second,other,_:=login("123456");second.hello();if other["visitorName"]!=info["visitorName"]||other["userId"]==info["userId"]{t.Fatal("account display or device scope wrong")}
 second.send(prompt("other-device-no-grant","pi-a"));if second.receive("command_result")["code"]!="CONTROL_REQUIRED"{t.Fatal("other device inherited approval")}
}
func TestAccountExpiredProofClosesRoomEvenWhenBrowserDoesNotSignOut(t *testing.T){
 f:=roomFixture(t,false);v,sign,_:=accountTestSigner(t);f.agent.accounts=v;r:=connectRoom(t,f,false);key,_:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);proof:=visitorTestProof(t,key,r.key,r.b.opened.ID,r.nonce,"拿铁");claims:=accountTestClaims(v,r.key,r.b.opened.ID,r.nonce,proof.PublicKey);claims.Expires=claims.Issued+3
 r.send(map[string]any{"type":"room.auth","id":r.b.opened.ID,"nonce":r.nonce,"password":"123456","nickname":"拿铁","visitor":proof,"account":sign(claims)});r.receive("room.authenticated");r.hello()
 f.agent.mu.Lock();session:=f.agent.sessions[r.b.opened.ID];f.agent.mu.Unlock();if session==nil{t.Fatal("no account session")}
 select{case<-session.stop:case<-time.After(6*time.Second):t.Fatal("expired account assertion kept room alive")}
}
func TestAccountGrantIdentityDoesNotDependOnNicknameOrCopyAcrossDevices(t *testing.T){
 v,_,_:=accountTestSigner(t);c:=accountTestClaims(v,"room","id","nonce","key-one");original:=Identity{ID:"one",Role:"operator",Room:"main"};a:=accountIdentity(original,c,"room");c.Name="美式";b:=accountIdentity(original,c,"room");if a.UserID!=b.UserID||a.Name==b.Name{t.Fatal("nickname changed authority")};c.PublicKey="key-two";d:=accountIdentity(original,c,"room");if d.UserID==a.UserID{t.Fatal("device copied grant")};c.PublicKey="key-one";c.Session,_=NewToken();if accountIdentity(original,c,"room").UserID==a.UserID{t.Fatal("new login inherited old grant")}
}
