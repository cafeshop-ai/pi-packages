package service

import (
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/http/httptest"
 "os"
 "path/filepath"
 "runtime"
 "strings"
 "sync"
 "testing"
 "time"

 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
 "github.com/gorilla/websocket"
)
const setupTestToken = "123456" // Deliberately simple: local custom tokens have no complexity requirement.
func setupFixture(t *testing.T)(*Service,config.Config) {
 t.Helper();c,err:=config.Parse(map[string]string{});if err!=nil{t.Fatal(err)}
 c.CredentialsFile=filepath.Join(t.TempDir(),"private","credentials.json")
 s,err:=New(c,Options{});if err!=nil{t.Fatal(err)}
 t.Cleanup(func(){ctx,cancel:=context.WithTimeout(context.Background(),3*time.Second);defer cancel();_ = s.Close(ctx)})
 return s,c
}
func setupCall(s *Service,method,path,body,nonce string,mutate func(*http.Request))*httptest.ResponseRecorder {
 r:=httptest.NewRequest(method,"http://127.0.0.1:37891"+path,strings.NewReader(body));r.RemoteAddr="127.0.0.1:42001"
 if nonce!=""{r.Header.Set("X-Cafe-Setup",nonce)}
 if method=="POST"{r.Header.Set("Content-Type","application/json");r.Header.Set("Origin","http://127.0.0.1:37891")}
 if mutate!=nil{mutate(r)};w:=httptest.NewRecorder();s.HTTP.Handler.ServeHTTP(w,r);return w
}
func setupNonce(t *testing.T,s *Service)string {
 t.Helper();w:=setupCall(s,"GET","/api/setup","","1",nil);if w.Code!=200{t.Fatal(w.Code,w.Body.String())};var v map[string]any
 if json.Unmarshal(w.Body.Bytes(),&v)!=nil{t.Fatal("invalid setup response")};n,ok:=v["nonce"].(string);if !ok{t.Fatal("missing challenge")};return n
}
func setupBody(token string)string{b,_:=json.Marshal(map[string]string{"token":token,"confirmToken":token});return string(b)}
func TestLocalSetupBlocksUntilUserInitializes(t *testing.T) {
 s,c:=setupFixture(t)
 if w:=setupCall(s,"GET","/api/config","","",nil);w.Code!=200||!strings.Contains(w.Body.String(),`"setupRequired":true`){t.Fatal(w.Code,w.Body.String())}
 if w:=setupCall(s,"GET","/ws","","",nil);w.Code!=423{t.Fatal("uninitialized ws available",w.Code)}
 n:=setupNonce(t,s);w:=setupCall(s,"POST","/api/setup",setupBody(setupTestToken),n,nil)
 if w.Code!=201||strings.Contains(w.Body.String(),setupTestToken){t.Fatal(w.Code,w.Body.String())}
 saved,err:=readLocalCredentials(c.CredentialsFile,c.Port);if err!=nil||saved==nil{t.Fatal("credentials missing",err)}
 if saved.ClientToken!=setupTestToken||saved.HostToken==saved.ClientToken||saved.HostToken=="local-dev-host-token"{t.Fatal("role keys not isolated")}
 if runtime.GOOS!="windows"{info,_:=os.Stat(c.CredentialsFile);if info.Mode().Perm()!=0600{t.Fatal("credential permissions")}}
 w=setupCall(s,"GET","/api/setup","","1",nil);if strings.Contains(w.Body.String(),"nonce")||strings.Contains(w.Body.String(),saved.HostToken){t.Fatal("post-setup secret leak")}
 if w=setupCall(s,"POST","/api/setup",setupBody("Another_Custom_8a2g9kL3!"),n,nil);w.Code!=409{t.Fatal("reinitialization allowed")}
 restarted,err:=New(c,Options{});if err!=nil{t.Fatal(err)};defer restarted.Close(context.Background())
 if w=setupCall(restarted,"GET","/api/config","","",nil);strings.Contains(w.Body.String(),"setupRequired"){t.Fatal("setup repeated after restart")}
 again,_:=readLocalCredentials(c.CredentialsFile,c.Port);if *again!=*saved{t.Fatal("saved tokens overwritten")}
}
func TestLocalSetupRejectsUnsafeRequests(t *testing.T) {
 s,c:=setupFixture(t);n:=setupNonce(t,s)
 cases:=[]struct{name,body,nonce string; mutate func(*http.Request); status int}{
  {"missing challenge",setupBody(setupTestToken),"",nil,403},
  {"wrong challenge",setupBody(setupTestToken),"wrong",nil,403},
  {"mismatch",`{"token":"`+setupTestToken+`","confirmToken":"other"}`,n,nil,400},
  {"empty",setupBody(""),n,nil,400},
  {"too long",setupBody(strings.Repeat("a",21)),n,nil,400},
  {"control character",setupBody("a\nb"),n,nil,400},
  {"duplicate",`{"token":"x","token":"x","confirmToken":"x"}`,n,nil,400},
  {"unknown",`{"token":"x","confirmToken":"x","hostToken":"injected"}`,n,nil,400},
  {"foreign origin",setupBody(setupTestToken),n,func(r *http.Request){r.Header.Set("Origin","https://evil.invalid")},403},
  {"dns rebinding",setupBody(setupTestToken),n,func(r *http.Request){r.Host="evil.invalid:37891";r.Header.Set("Origin","http://evil.invalid:37891")},403},
  {"remote peer",setupBody(setupTestToken),n,func(r *http.Request){r.RemoteAddr="192.0.2.10:1234"},403},
  {"fetch metadata",setupBody(setupTestToken),n,func(r *http.Request){r.Header.Set("Sec-Fetch-Site","cross-site")},403},
  {"simple form",setupBody(setupTestToken),n,func(r *http.Request){r.Header.Set("Content-Type","text/plain")},415},
  {"oversized",strings.Repeat("x",2049),n,nil,413},
 }
 for _,test:=range cases{t.Run(test.name,func(t *testing.T){w:=setupCall(s,"POST","/api/setup",test.body,test.nonce,test.mutate);if w.Code!=test.status{t.Fatal(w.Code,w.Body.String())}})}
 if _,err:=os.Stat(c.CredentialsFile);!os.IsNotExist(err){t.Fatal("invalid request created credentials")}
 if w:=setupCall(s,"GET","/api/setup","","",nil);w.Code!=403{t.Fatal("challenge endpoint allowed simple cross-origin request")}
}
func TestLocalSetupConcurrentSubmissionHasOneWinner(t *testing.T) {
 s,_:=setupFixture(t);n:=setupNonce(t,s);var wg sync.WaitGroup;codes:=make(chan int,8)
 for i:=0;i<8;i++{wg.Add(1);go func(){defer wg.Done();codes<-setupCall(s,"POST","/api/setup",setupBody(setupTestToken),n,nil).Code}()};wg.Wait();close(codes)
 success:=0;for code:=range codes{if code==201{success++}else if code!=409{t.Fatal("unexpected code",code)}};if success!=1{t.Fatal("multiple initialization winners",success)}
}
func TestLocalSetupCorruptOrPublicCredentialsDoNotReset(t *testing.T) {
 s,c:=setupFixture(t);n:=setupNonce(t,s);if setupCall(s,"POST","/api/setup",setupBody(setupTestToken),n,nil).Code!=201{t.Fatal("init")}
 if err:=os.WriteFile(c.CredentialsFile,[]byte("broken"),0600);err!=nil{t.Fatal(err)}
 if next,err:=New(c,Options{});err==nil{next.Close(context.Background());t.Fatal("corrupt credentials reset to defaults")}
 if runtime.GOOS!="windows" {
  value:=localCredentials{Version:1,Port:c.Port,HostToken:strings.Repeat("a",43),ClientToken:setupTestToken};raw,_:=json.Marshal(value)
  _ = os.WriteFile(c.CredentialsFile,raw,0600);_ = os.Chmod(c.CredentialsFile,0644)
  if _,err:=readLocalCredentials(c.CredentialsFile,c.Port);err==nil{t.Fatal("public credential file accepted")}
 }
}
func TestLocalSetupPreservesPreviouslySavedLongToken(t *testing.T) {
 _,c:=setupFixture(t)
 host,err:=randomSetupToken();if err!=nil{t.Fatal(err)}
 value:=localCredentials{Version:1,Port:c.Port,HostToken:host,ClientToken:strings.Repeat("a",64)}
 if config.ValidSetupToken(value.ClientToken){t.Fatal("new setup accepted legacy length")}
 if err=saveLocalCredentials(c.CredentialsFile,value);err!=nil{t.Fatal(err)}
 before,err:=os.ReadFile(c.CredentialsFile);if err!=nil{t.Fatal(err)}
 restarted,err:=New(c,Options{});if err!=nil{t.Fatal(err)};defer restarted.Close(context.Background())
 stored,err:=readLocalCredentials(c.CredentialsFile,c.Port);if err!=nil||stored.ClientToken!=value.ClientToken{t.Fatal("legacy token invalidated",err)}
 after,_:=os.ReadFile(c.CredentialsFile);if string(before)!=string(after){t.Fatal("existing credentials rewritten")}
}
func TestLocalSetupAuthenticatesOnlyNewRoleKeys(t *testing.T) {
 listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{t.Fatal(err)}
 c,_:=config.Parse(map[string]string{});c.Port=listener.Addr().(*net.TCPAddr).Port;c.CredentialsFile=filepath.Join(t.TempDir(),"private","credentials.json")
 s,err:=New(c,Options{});if err!=nil{listener.Close();t.Fatal(err)};go s.Serve(listener);defer s.Close(context.Background())
 base:=fmt.Sprintf("http://127.0.0.1:%d",c.Port)
 get,_:=http.NewRequest("GET",base+"/api/setup",nil);get.Header.Set("X-Cafe-Setup","1");response,err:=http.DefaultClient.Do(get);if err!=nil{t.Fatal(err)}
 var state map[string]any;_ = json.NewDecoder(response.Body).Decode(&state);response.Body.Close()
 post,_:=http.NewRequest("POST",base+"/api/setup",strings.NewReader(setupBody(setupTestToken)));post.Header.Set("Content-Type","application/json");post.Header.Set("Origin",base);post.Header.Set("X-Cafe-Setup",state["nonce"].(string))
 response,err=http.DefaultClient.Do(post);if err!=nil{t.Fatal(err)};_,_=io.Copy(io.Discard,response.Body);response.Body.Close();if response.StatusCode!=201{t.Fatal(response.StatusCode)}
 for _,token:=range []string{"local-dev-client-token",setupTestToken}{
  conn,_,err:=websocket.DefaultDialer.Dial(strings.Replace(base,"http:","ws:",1)+"/ws",nil);if err!=nil{t.Fatal(err)}
  _ = conn.WriteJSON(map[string]any{"type":"hello","protocolVersion":1,"peerRole":"client","peerId":"test-client","roomId":"main","token":token});_ = conn.SetReadDeadline(time.Now().Add(3*time.Second))
  var message map[string]any;if err=conn.ReadJSON(&message);err!=nil{conn.Close();t.Fatal(err)};conn.Close()
  expected:="error";if token==setupTestToken{expected="welcome"};if message["type"]!=expected{t.Fatal("wrong authentication result",message["type"])}
 }
}
