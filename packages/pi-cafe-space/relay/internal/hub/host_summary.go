package hub

// HostSummary reads only registry-owned metadata, never the room actor's
// snapshots. It is exposed only behind local authenticated management routes.
func (h *Hub) HostSummary(roomID, peerID string) (count int, present bool) {
 h.mu.Lock()
 defer h.mu.Unlock()
 seen := map[string]bool{}
 for c := range h.connections {
  if c.authenticated && c.active() && c.role == "host" && c.room != nil && c.room.id == roomID {
   seen[c.peer] = true
   if c.peer == peerID { present = true }
  }
 }
 return len(seen), present
}
