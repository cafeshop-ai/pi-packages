package collaboration

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// history fills a room with n stored messages without going through the send rate limit.
func history(t *testing.T, s *Store, id string, n int, text func(int) string) {
	t.Helper()
	room := s.rooms[id]
	for i := 1; i <= n; i++ {
		room.Messages = append(room.Messages, Message{Seq: i, ID: fmt.Sprintf("history-%d", i), MemberID: room.Members[0].ID, Text: text(i), At: s.now()})
	}
	if err := s.save(room); err != nil {
		t.Fatal(err)
	}
}

func seqs(page map[string]any) []int {
	out := []int{}
	for _, m := range page["messages"].([]any) {
		out = append(out, int(m.(map[string]any)["seq"].(float64)))
	}
	return out
}

func span(t *testing.T, page map[string]any, first, last int) {
	t.Helper()
	got := seqs(page)
	if len(got) != last-first+1 || len(got) > 0 && (got[0] != first || got[len(got)-1] != last) {
		t.Fatalf("want messages %d..%d, got %v", first, last, got)
	}
}

func TestLatestCatchesUpWithoutLoadingTheWholeHistory(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	history(t, s, id, 571, func(i int) string { return fmt.Sprintf("message %d", i) })
	if features := call(t, s, map[string]any{"op": "status"}, "", 200)["features"].([]any); !slices.Contains(features, any("history")) {
		t.Fatal("status must advertise history reads")
	}
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 30}, owner, 200)
	span(t, page, 542, 571)
	if page["cursor"] != float64(571) || page["more"] != false || page["older"] != true || page["latestSeq"] != float64(571) || page["tasks"] == nil {
		t.Fatalf("latest must end at the newest seq with the board: %v", page)
	}
	// Following from that cursor sees only what is new.
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "after-catch-up", "text": "new"}, owner, 200)
	next := call(t, s, map[string]any{"op": "read", "roomId": id, "after": 571}, owner, 200)
	span(t, next, 572, 572)
	if all := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 100}, owner, 200); len(seqs(all)) != 100 || all["older"] != true {
		t.Fatal("latest is capped at one page")
	}
	small := store(t)
	sid, stoken := create(t, small)
	history(t, small, sid, 3, func(i int) string { return "x" })
	if few := call(t, small, map[string]any{"op": "read", "roomId": sid, "latest": 30}, stoken, 200); len(seqs(few)) != 3 || few["older"] != false || few["cursor"] != float64(3) {
		t.Fatalf("latest on a short room returns everything: %v", few)
	}
}

func TestBeforePagesOlderMessagesWithoutACursor(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	history(t, s, id, 250, func(i int) string { return fmt.Sprintf("message %d", i) })
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "before": 201, "limit": 50}, owner, 200)
	span(t, page, 151, 200)
	if _, ok := page["cursor"]; ok {
		t.Fatal("an older page must not carry a cursor a client could persist")
	}
	if _, ok := page["more"]; ok || page["older"] != true || page["latestSeq"] != float64(250) {
		t.Fatalf("older page metadata: %v", page)
	}
	first := call(t, s, map[string]any{"op": "read", "roomId": id, "before": 21, "limit": 50}, owner, 200)
	span(t, first, 1, 20)
	if first["older"] != false {
		t.Fatal("the first page has nothing older")
	}
	if empty := call(t, s, map[string]any{"op": "read", "roomId": id, "before": 1}, owner, 200); len(seqs(empty)) != 0 || empty["older"] != false {
		t.Fatal("before=1 is an empty page")
	}
	// before = newest+1 is the same as latest with limit.
	span(t, call(t, s, map[string]any{"op": "read", "roomId": id, "before": 251, "limit": 10}, owner, 200), 241, 250)
	// A single message, whole: how a reader expands a truncated excerpt.
	span(t, call(t, s, map[string]any{"op": "read", "roomId": id, "before": 8, "limit": 1}, owner, 200), 7, 7)
	// limit also sizes forward pages; the cursor stays exact.
	forward := call(t, s, map[string]any{"op": "read", "roomId": id, "after": 10, "limit": 5}, owner, 200)
	span(t, forward, 11, 15)
	if forward["cursor"] != float64(15) || forward["more"] != true {
		t.Fatalf("forward page with limit: %v", forward)
	}
}

func TestExcerptCutsLongTextsInTheViewOnly(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	long := strings.Repeat("长", 500)
	history(t, s, id, 2, func(i int) string {
		if i == 1 {
			return long
		}
		return "short"
	})
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 2, "excerpt": 40}, owner, 200)["messages"].([]any)
	cut, whole := page[0].(map[string]any), page[1].(map[string]any)
	if cut["text"] != strings.Repeat("长", 40)+"…" || cut["truncated"] != true {
		t.Fatalf("excerpt must cut by characters and mark it: %v", cut)
	}
	if whole["text"] != "short" || whole["truncated"] != nil {
		t.Fatal("short texts stay whole and unmarked")
	}
	if full := call(t, s, map[string]any{"op": "read", "roomId": id, "before": 2, "limit": 1}, owner, 200)["messages"].([]any)[0].(map[string]any); full["text"] != long || full["truncated"] != nil {
		t.Fatal("the stored message must stay whole")
	}
	if s.rooms[id].Messages[0].Text != long || s.rooms[id].Messages[0].Truncated {
		t.Fatal("excerpt must not change stored messages")
	}
}

func TestHistoryReadsRejectAmbiguousRequests(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	history(t, s, id, 10, func(i int) string { return "x" })
	for _, q := range []map[string]any{
		{"latest": 101}, {"latest": -1}, {"latest": 0}, {"latest": 5, "after": 2}, {"latest": 5, "before": 3},
		{"before": 12}, {"before": -1}, {"before": 0}, {"before": 5, "after": 2},
	} {
		q["op"], q["roomId"] = "read", id
		if v := call(t, s, q, owner, 400); v["error"] != "INVALID_CURSOR" {
			t.Fatalf("%v: %v", q, v)
		}
	}
	for _, q := range []map[string]any{
		{"limit": 101}, {"limit": -1}, {"limit": 0}, {"latest": 5, "limit": 5}, {"after": 1, "excerpt": 39}, {"after": 1, "excerpt": 2001}, {"after": 1, "excerpt": 0},
	} {
		q["op"], q["roomId"] = "read", id
		if v := call(t, s, q, owner, 400); v["error"] != "INVALID_LIMIT" {
			t.Fatalf("%v: %v", q, v)
		}
	}
	for _, q := range []map[string]any{{"before": 5, "wait": 1}, {"latest": 5, "wait": 1}} {
		q["op"], q["roomId"] = "read", id
		if v := call(t, s, q, owner, 400); v["error"] != "INVALID_WAIT" {
			t.Fatalf("wait is only for after reads: %v", q)
		}
	}
	// Plain after reads keep their exact old shape.
	old := call(t, s, map[string]any{"op": "read", "roomId": id, "after": 0}, owner, 200)
	span(t, old, 1, 10)
	if old["cursor"] != float64(10) || old["more"] != false {
		t.Fatal("after reads are unchanged")
	}
}

func TestGuideAndContractSteerAgentsToCatchUpFromTheTail(t *testing.T) {
	s := store(t)
	doc := contractFrom(t, s)
	read := doc["components"].(map[string]any)["schemas"].(map[string]any)["read"].(map[string]any)["properties"].(map[string]any)
	for _, field := range []string{"after", "latest", "before", "limit", "excerpt", "wait"} {
		if read[field] == nil {
			t.Errorf("contract read must describe %s", field)
		}
	}
	guide := s.guide()
	for _, want := range []string{`"latest":30`, "Do not load the whole history into your context", `"before":`, `"excerpt":`, "never moves yours", "latestSeq"} {
		if !strings.Contains(guide, want) {
			t.Errorf("guide must explain %q", want)
		}
	}
	if strings.Contains(guide, `"after":0}. Persist cursor`) {
		t.Error("guide must no longer start agents by reading the whole history")
	}
}

func TestFailedSendLeavesSharedHistoryIntact(t *testing.T) {
	s := store(t)
	id, owner := create(t, s)
	history(t, s, id, 3, func(i int) string { return fmt.Sprintf("message %d", i) })
	// Give the stored slice spare capacity, the case where an unclipped append would write into it.
	room := s.rooms[id]
	room.Messages = append(make([]Message, 0, 16), room.Messages...)
	page := call(t, s, map[string]any{"op": "read", "roomId": id, "latest": 3}, owner, 200)
	s.directory = filepath.Join(t.TempDir(), "missing")
	call(t, s, map[string]any{"op": "send", "roomId": id, "id": "lost-message", "text": "not saved"}, owner, 503)
	if got := s.rooms[id].Messages; len(got) != 3 || got[:4][3].Text != "" {
		t.Fatalf("a failed send must not publish or write into the stored array: %v", got[:4])
	}
	if text := page["messages"].([]any)[2].(map[string]any)["text"]; text != "message 3" {
		t.Fatal("an earlier page must stay as served")
	}
}
