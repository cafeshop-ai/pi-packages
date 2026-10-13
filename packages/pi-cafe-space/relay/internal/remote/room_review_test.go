package remote

import (
 "net/http"
 "net/http/httptest"
 "testing"
 "time"
)

func TestRoomJoinBudgetsAreIndependent(t *testing.T) {
 now:=time.Now();first,second:=&roomJoinBudget{},&roomJoinBudget{}
 for i:=0;i<120;i++{if !first.admit(now){t.Fatal("budget rejected before limit")}}
 if first.admit(now){t.Fatal("room rate limit disappeared")}
 if !second.admit(now){t.Fatal("another room shared the exhausted budget")}
 if !first.admit(now.Add(time.Minute+time.Second)){t.Fatal("room did not recover after window")}
}

func TestRoomNonWebSocketRequestsDoNotExhaustJoining(t *testing.T) {
 f:=roomFixture(t,false)
 for i:=0;i<121;i++ {
  request:=httptest.NewRequest("GET",f.server.URL+"/room/join",nil)
  request.Header.Set("Origin",f.server.URL)
  response:=httptest.NewRecorder()
  f.cloud.Wrap(http.NotFoundHandler()).ServeHTTP(response,request)
  if response.Code!=http.StatusBadRequest {t.Fatalf("invalid HTTP request %d affected room admission: status %d",i+1,response.Code)}
 }
 browser:=connectRoom(t,f,false)
 browser.authenticate("123456")
 browser.receive("room.authenticated")
 browser.hello()
}
