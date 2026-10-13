import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDefaults} from './defaults.ts';
const connection={relayUrl:'ws://127.0.0.1:37983/ws',room:'manual-trial',hostToken:'HOST_TEST_ONLY',clientToken:'CLIENT_TEST_ONLY'};
test('normal Pi gets shared local endpoint/room/tokens, never a fixed peer ID or provider configuration',()=>{
 assert.deepEqual(localDefaults(connection,{},undefined),{PI_COLLAB_RELAY_URL:connection.relayUrl,PI_COLLAB_ROOM:connection.room,PI_COLLAB_HOST_TOKEN:connection.hostToken,PI_COLLAB_CLIENT_TOKEN:connection.clientToken});
});
test('explicit other endpoints never receive local credentials',()=>{
 for(const url of ['wss://other.example/ws','ws://127.0.0.1:37891/ws','ws://localhost:37983/ws',' '.repeat(8193)]){
  assert.deepEqual(localDefaults(connection,{},url),{});
  assert.deepEqual(localDefaults(connection,{PI_COLLAB_RELAY_URL:url},undefined),{});
 }
});
test('explicit environment, opt-out and room flags are preserved',()=>{
 const env={PI_COLLAB_ROOM:'other',PI_COLLAB_HOST_TOKEN:'explicit',PI_COLLAB_CLIENT_TOKEN:'explicit-client',PI_COLLAB_ENABLED:'0',PI_COLLAB_PEER_ID:'explicit-peer'};
 assert.deepEqual(localDefaults(connection,env,connection.relayUrl),{});
 assert.equal(env.PI_COLLAB_ENABLED,'0');assert.equal(env.PI_COLLAB_PEER_ID,'explicit-peer');
 assert.deepEqual(localDefaults(connection,{PI_COLLAB_HOST_TOKEN:'',PI_COLLAB_CLIENT_TOKEN:''},undefined,'custom'),{PI_COLLAB_RELAY_URL:connection.relayUrl});
});
