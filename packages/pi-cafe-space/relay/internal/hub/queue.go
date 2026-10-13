package hub

// ReserveQueue/ReleaseQueue account for transport-owned immutable application
// buffers in the same global dynamic-state budget as room inboxes/projections.
// No registry locks, actor waits or network calls occur here.
func (h *Hub) ReserveQueue(bytes int) bool {
	if bytes < 0 {
		return false
	}
	return h.budget.replace(0, bytes)
}
func (h *Hub) ReleaseQueue(bytes int) {
	if bytes >= 0 {
		h.budget.replace(bytes, 0)
	}
}
