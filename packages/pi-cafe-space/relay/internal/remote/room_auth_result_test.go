package remote

import (
 "testing"
 "time"
)

func TestRoomAuthenticationReportsCapacitySeparately(t *testing.T) {
 for _,scenario:=range []struct{name,code string;busy bool;limited bool}{{"busy","ROOM_AUTH_BUSY",true,false},{"rate","ROOM_AUTH_RATE_LIMITED",false,true}} {
  t.Run(scenario.name,func(t *testing.T){
   f:=roomFixture(t,false);owner:=f.agent.room
   owner.mu.Lock();owner.verifying=scenario.busy;owner.window=time.Now();if scenario.limited{owner.attempts=roomPasswordAttemptLimit};owner.mu.Unlock()
   browser:=connectRoom(t,f,false);browser.authenticate("123456");denied:=browser.receive("room.denied")
   if denied["code"]!=scenario.code{t.Fatal("correct password mislabeled",denied)}
   retry,ok:=denied["retryAfterSeconds"].(float64);if !ok||retry<1||retry>60{t.Fatal("missing bounded retry hint",denied)}
   owner.mu.Lock();owner.verifying=false;owner.attempts=0;owner.mu.Unlock()
   fresh:=connectRoom(t,f,false);fresh.authenticate("123456");fresh.receive("room.authenticated");fresh.hello()
  })
 }
}
