package service

import (
 "context"
 "encoding/json"
 "net/http/httptest"
 "os"
 "path/filepath"
 "strings"
 "testing"
 "testing/fstest"

 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/remote"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/webui"
)

func TestCloudPageExplicitSameSiteWebSocketPolicy(t *testing.T) {
 assets,err:=webui.Load(fstest.MapFS{"index.html":{Data:[]byte("<html>test</html>")}},[]string{"index.html"});if err!=nil{t.Fatal(err)}
 for _,origin:=range []string{"https://rooms.example","https://rooms.example:8443","http://127.0.0.1:37912"}{
  t.Run(origin,func(t *testing.T){
   data,_:=json.Marshal(remote.Config{Mode:"cloud",PublicOrigin:origin,RoomAccess:true,EnableWebRTC:true})
   path:=filepath.Join(t.TempDir(),"cloud.json");if err:=os.WriteFile(path,data,0600);err!=nil{t.Fatal(err)}
   s,err:=New(config.Config{Host:"127.0.0.1",Port:37892,HostToken:"host-test",ClientToken:"client-test",RemoteConfig:path},Options{Assets:assets});if err!=nil{t.Fatal(err)};defer s.Close(context.Background())
   r:=httptest.NewRequest("GET","http://untrusted.invalid/",nil);r.Header.Set("X-Forwarded-Host","attacker.invalid");r.Header.Set("X-Forwarded-Proto","http");w:=httptest.NewRecorder();s.HTTP.Handler.ServeHTTP(w,r)
   if w.Code!=200{t.Fatalf("page status %d",w.Code)}
   csp:=w.Header().Get("Content-Security-Policy");expected:="connect-src 'self' "+strings.Replace(origin,"http","ws",1)+";"
   if !strings.Contains(csp,expected){t.Fatalf("explicit own WebSocket missing: %s",csp)}
   for _,bad:=range []string{"wss:;","ws:;","connect-src *","attacker.invalid","untrusted.invalid"}{if strings.Contains(csp,bad){t.Fatalf("untrusted/wildcard destination: %s",csp)}}
   for _,needed:=range []string{"script-src 'self'","object-src 'none'","base-uri 'none'","frame-ancestors 'none'"}{if !strings.Contains(csp,needed){t.Fatal("lost existing directive",needed)}}
  })
 }
}
